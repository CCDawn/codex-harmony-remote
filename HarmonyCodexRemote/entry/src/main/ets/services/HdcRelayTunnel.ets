import socket from '@ohos.net.socket';

export interface HdcRelayConfig {
  relayHost: string;
  relayPort: number;
  deviceId: string;
  token: string;
  hdcdHost: string;
  hdcdPort: number;
}

export type HdcRelayState = '已停止' | '连接中' | '等待电脑' | '已配对' | '转发中' | '重连中' | '错误';

export type HdcRelayStatusCallback = (state: HdcRelayState, detail: string) => void;
export type HdcRelayMetricCallback = (relayToHdcdBytes: number, hdcdToRelayBytes: number) => void;

interface RelayHello {
  ok?: boolean;
  mode?: string;
  error?: string;
  channelId?: string;
}

export class HdcRelayTunnel {
  private relaySocket: socket.TCPSocket | null = null;
  private hdcdSocket: socket.TCPSocket | null = null;
  private running: boolean = false;
  private paired: boolean = false;
  private pairing: boolean = false;
  private generation: number = 0;
  private controlBytes: number[] = [];
  private pendingHdcdBytes: ArrayBuffer[] = [];
  private readonly onStatus: HdcRelayStatusCallback;
  private readonly onMetric: HdcRelayMetricCallback;
  private relayToHdcdBytes: number = 0;
  private hdcdToRelayBytes: number = 0;

  constructor(onStatus: HdcRelayStatusCallback, onMetric: HdcRelayMetricCallback = () => {}) {
    this.onStatus = onStatus;
    this.onMetric = onMetric;
  }

  start(config: HdcRelayConfig): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.loop(config, this.generation);
  }

  restart(config: HdcRelayConfig): void {
    this.generation += 1;
    this.running = true;
    this.paired = false;
    this.closeSockets();
    this.onStatus('重连中', '正在自动重启无线 HDC 中继');
    this.loop(config, this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.paired = false;
    this.closeSockets();
    this.onStatus('已停止', '中继已手动停止');
  }

  private async loop(config: HdcRelayConfig, generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      try {
        await this.connectOnce(config, generation);
      } catch (error) {
        if (this.generation === generation) {
          this.onStatus('错误', this.errorText(error));
        }
      }
      if (this.running && this.generation === generation) {
        this.onStatus('重连中', '1.5 秒后自动重连');
        await this.sleep(1500);
      }
    }
  }

  private async connectOnce(config: HdcRelayConfig, generation: number): Promise<void> {
    this.paired = false;
    this.pairing = false;
    this.controlBytes = [];
    this.pendingHdcdBytes = [];
    this.relayToHdcdBytes = 0;
    this.hdcdToRelayBytes = 0;
    this.emitMetric();
    this.closeSockets();

    this.onStatus('连接中', `连接 Relay ${config.relayHost}:${config.relayPort}`);
    const relay = socket.constructTCPSocketInstance();
    this.relaySocket = relay;
    relay.on('message', (info: socket.SocketMessageInfo) => {
      void this.handleRelayMessage(config, info.message, generation);
    });
    relay.on('close', () => {
      if (this.running && this.generation === generation) {
        this.onStatus('重连中', 'Relay 连接已关闭');
      }
    });
    relay.on('error', (error: Error) => {
      if (this.running && this.generation === generation) {
        this.onStatus('错误', `Relay 错误：${this.errorText(error)}`);
        this.closeSockets();
      }
    });

    try {
      await relay.connect({
        address: {
          address: config.relayHost,
          port: config.relayPort,
          family: 1
        },
        timeout: 8000
      });
      await relay.send({
        data: JSON.stringify({
          role: 'phone',
          deviceId: config.deviceId,
          token: config.token
        }) + '\n',
        encoding: 'utf-8'
      });
    } catch (error) {
      throw new Error(`连接 Relay 失败：${this.errorText(error)}`);
    }
    this.onStatus('等待电脑', '已连接 Relay，等待本地电脑接入');

    await new Promise<void>((resolve) => {
      relay.on('close', () => resolve());
    });
  }

  private async handleRelayMessage(config: HdcRelayConfig, data: ArrayBuffer, generation: number): Promise<void> {
    if (!this.running || this.generation !== generation) {
      return;
    }
    try {
      await this.handleRelayMessageInner(config, data, generation);
    } catch (error) {
      if (this.running && this.generation === generation) {
        this.onStatus('错误', this.errorText(error));
        this.closeSockets();
      }
    }
  }

  private async handleRelayMessageInner(config: HdcRelayConfig, data: ArrayBuffer, generation: number): Promise<void> {
    if (this.paired) {
      await this.sendToHdcd(data);
      return;
    }
    if (this.pairing) {
      this.pendingHdcdBytes.push(data);
      return;
    }

    const incoming = new Uint8Array(data);
    for (let index = 0; index < incoming.length; index += 1) {
      this.controlBytes.push(incoming[index]);
    }
    const newlineIndex = this.controlBytes.indexOf(0x0a);
    if (newlineIndex < 0) {
      return;
    }

    const lineBytes = this.controlBytes.slice(0, newlineIndex);
    const restBytes = this.controlBytes.slice(newlineIndex + 1);
    const line = this.bytesToString(lineBytes).trim();
    const rest = this.bytesToArrayBuffer(restBytes);
    this.controlBytes = [];
    const hello = JSON.parse(line) as RelayHello;
    if (!hello.ok) {
      throw new Error(hello.error ?? 'Relay 拒绝连接');
    }
    if (hello.mode === 'waiting') {
      this.onStatus('等待电脑', 'Relay 在线，等待电脑代理连接');
      return;
    }
    if (hello.mode !== 'paired') {
      throw new Error(`未知 Relay 状态：${hello.mode ?? ''}`);
    }

    this.onStatus('已配对', `通道 ${hello.channelId ?? ''}`);
    this.pairing = true;
    await this.connectHdcd(config, generation);
    this.paired = true;
    this.pairing = false;
    this.onStatus('转发中', '电脑 HDC 已接入，正在转发 hdcd 字节流');
    if (rest.byteLength > 0) {
      await this.sendToHdcd(rest);
    }
    await this.flushPendingHdcdBytes();
  }

  private async connectHdcd(config: HdcRelayConfig, generation: number): Promise<void> {
    const hdcd = socket.constructTCPSocketInstance();
    this.hdcdSocket = hdcd;
    hdcd.on('message', (info: socket.SocketMessageInfo) => {
      if (this.running && this.generation === generation) {
        void this.sendToRelay(info.message);
      }
    });
    hdcd.on('close', () => {
      if (this.running && this.generation === generation) {
        this.onStatus('重连中', '本机 hdcd 连接已关闭');
        this.relaySocket?.close();
      }
    });
    hdcd.on('error', (error: Error) => {
      if (this.running && this.generation === generation) {
        this.onStatus('错误', `hdcd 错误：${this.errorText(error)}`);
        this.closeSockets();
      }
    });
    try {
      await hdcd.connect({
        address: {
          address: config.hdcdHost,
          port: config.hdcdPort,
          family: 1
        },
        timeout: 5000
      });
    } catch (error) {
      throw new Error(`连接本机 hdcd 失败：${this.errorText(error)}`);
    }
  }

  private async sendToRelay(data: ArrayBuffer): Promise<void> {
    try {
      if (this.relaySocket) {
        await this.relaySocket.send({ data });
        this.hdcdToRelayBytes += data.byteLength;
        this.emitMetric();
      }
    } catch (error) {
      this.onStatus('错误', `发送到 Relay 失败：${this.errorText(error)}`);
      this.closeSockets();
    }
  }

  private async sendToHdcd(data: ArrayBuffer): Promise<void> {
    try {
      if (this.hdcdSocket) {
        await this.hdcdSocket.send({ data });
        this.relayToHdcdBytes += data.byteLength;
        this.emitMetric();
      }
    } catch (error) {
      this.onStatus('错误', `发送到 hdcd 失败：${this.errorText(error)}`);
      this.closeSockets();
    }
  }

  private async flushPendingHdcdBytes(): Promise<void> {
    const pending = this.pendingHdcdBytes;
    this.pendingHdcdBytes = [];
    for (let index = 0; index < pending.length; index += 1) {
      await this.sendToHdcd(pending[index]);
    }
  }

  private closeSockets(): void {
    this.pairing = false;
    this.pendingHdcdBytes = [];
    try {
      this.relaySocket?.close();
    } catch (_) {
    }
    try {
      this.hdcdSocket?.close();
    } catch (_) {
    }
    this.relaySocket = null;
    this.hdcdSocket = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitMetric(): void {
    this.onMetric(this.relayToHdcdBytes, this.hdcdToRelayBytes);
  }

  private errorText(error: Error | Object | string): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return JSON.stringify(error);
  }

  private arrayBufferToString(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value);
    return this.bytesToString(Array.from(bytes));
  }

  private bytesToString(bytes: number[]): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index]);
    }
    return text;
  }

  private bytesToArrayBuffer(value: number[]): ArrayBuffer {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value[index] & 0xff;
    }
    return bytes.buffer;
  }
}
