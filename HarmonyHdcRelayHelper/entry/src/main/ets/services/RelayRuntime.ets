import { common, wantAgent } from '@kit.AbilityKit';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HdcRelayConfig, HdcRelayState, HdcRelayTunnel } from './HdcRelayTunnel';
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_HDCD_HOST,
  DEFAULT_HDCD_PORT,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  DEFAULT_RELAY_TOKEN
} from '../config/RelayConfig';

export interface RelayRuntimeSnapshot {
  relayHost: string;
  relayPort: string;
  deviceId: string;
  token: string;
  hdcdHost: string;
  hdcdPort: string;
  running: boolean;
  stateText: HdcRelayState;
  detailText: string;
  relayToHdcdBytes: number;
  hdcdToRelayBytes: number;
  backgroundRunning: boolean;
  lastPairedAt: number;
  lastTransferAt: number;
  lastHealthCheckAt: number;
  restartCount: number;
  lastRecoverReason: string;
  foreground: boolean;
  healthTier: string;
  recommendedAction: string;
}

export type RelayRuntimeListener = (snapshot: RelayRuntimeSnapshot) => void;

class RelayRuntimeService {
  private context: common.UIAbilityContext | null = null;
  private listeners: RelayRuntimeListener[] = [];
  private running: boolean = false;
  private userStopped: boolean = false;
  private autoStarted: boolean = false;
  private backgroundRunning: boolean = false;
  private watchdogTimer: number = -1;
  private stateChangedAt: number = Date.now();
  private lastRestartAt: number = 0;
  private lastEmitHealthLogAt: number = 0;
  private backgroundCancelListenerRegistered: boolean = false;
  private lastBackgroundEnsureAt: number = 0;
  private lastObservedTransferBytes: number = 0;
  private lastObservedTransferAt: number = Date.now();
  private readonly backgroundCancelCallback = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    this.backgroundRunning = false;
    this.snapshot.backgroundRunning = false;
    this.snapshot.detailText = `后台长时任务被系统取消：${this.cancelReasonText(info.reason)}，正在恢复中继`;
    this.snapshot.lastRecoverReason = `后台任务取消：${this.cancelReasonText(info.reason)}`;
    this.logError(`background task canceled, id=${info.id}, reason=${info.reason}`);
    this.emit();
    if (!this.userStopped) {
      this.recoverNow(`后台任务取消：${this.cancelReasonText(info.reason)}`);
      setTimeout(() => {
        if (!this.userStopped && this.running) {
          void this.startBackgroundRunning();
        }
      }, 2500);
    }
  };
  private snapshot: RelayRuntimeSnapshot = {
    relayHost: DEFAULT_RELAY_HOST,
    relayPort: DEFAULT_RELAY_PORT,
    deviceId: DEFAULT_DEVICE_ID,
    token: DEFAULT_RELAY_TOKEN,
    hdcdHost: DEFAULT_HDCD_HOST,
    hdcdPort: DEFAULT_HDCD_PORT,
    running: false,
    stateText: '已停止',
    detailText: '等待自动启动',
    relayToHdcdBytes: 0,
    hdcdToRelayBytes: 0,
    backgroundRunning: false,
    lastPairedAt: 0,
    lastTransferAt: 0,
    lastHealthCheckAt: 0,
    restartCount: 0,
    lastRecoverReason: '尚未恢复',
    foreground: true,
    healthTier: 'offline',
    recommendedAction: 'start'
  };

  private tunnel: HdcRelayTunnel = new HdcRelayTunnel((state: HdcRelayState, detail: string) => {
    if (state === '已配对' || state === '转发中') {
      this.snapshot.lastPairedAt = Date.now();
    }
    if (this.snapshot.stateText !== state || this.snapshot.detailText !== detail) {
      this.stateChangedAt = Date.now();
      this.logInfo(`state=${state}, detail=${detail}`);
    }
    this.snapshot.stateText = state;
    this.snapshot.detailText = detail;
    if (state === '已停止') {
      this.running = false;
      this.snapshot.running = false;
    } else if (state === '错误') {
      this.running = false;
      this.snapshot.running = false;
      if (!this.userStopped) {
        this.ensureWatchdog();
      }
    }
    this.emit();
  }, (relayToHdcdBytes: number, hdcdToRelayBytes: number) => {
    if (relayToHdcdBytes !== this.snapshot.relayToHdcdBytes || hdcdToRelayBytes !== this.snapshot.hdcdToRelayBytes) {
      this.snapshot.lastTransferAt = Date.now();
    }
    this.snapshot.relayToHdcdBytes = relayToHdcdBytes;
    this.snapshot.hdcdToRelayBytes = hdcdToRelayBytes;
    this.emit();
  });

  attachContext(context: common.UIAbilityContext): void {
    this.context = context;
    this.registerBackgroundCancelListener();
    this.ensureWatchdog();
    if (this.running) {
      void this.startBackgroundRunning();
    }
    this.autoStart();
  }

  markForeground(foreground: boolean): void {
    this.snapshot.foreground = foreground;
    this.logInfo(foreground ? 'ability foreground' : 'ability background');
    if (!foreground && this.running) {
      void this.startBackgroundRunning();
    }
    if (foreground && !this.userStopped && (!this.running || this.snapshot.stateText === '错误')) {
      this.recoverNow('应用回到前台');
      return;
    }
    this.emit();
  }

  subscribe(listener: RelayRuntimeListener): void {
    this.listeners.push(listener);
    listener(this.cloneSnapshot());
  }

  unsubscribe(listener: RelayRuntimeListener): void {
    this.listeners = this.listeners.filter((item: RelayRuntimeListener) => item !== listener);
  }

  updateConfig(config: Partial<RelayRuntimeSnapshot>): void {
    if (this.running) {
      return;
    }
    this.snapshot.relayHost = config.relayHost ?? this.snapshot.relayHost;
    this.snapshot.relayPort = config.relayPort ?? this.snapshot.relayPort;
    this.snapshot.deviceId = config.deviceId ?? this.snapshot.deviceId;
    this.snapshot.token = config.token ?? this.snapshot.token;
    this.snapshot.hdcdHost = config.hdcdHost ?? this.snapshot.hdcdHost;
    this.snapshot.hdcdPort = config.hdcdPort ?? this.snapshot.hdcdPort;
    this.emit();
  }

  autoStart(): void {
    if (this.autoStarted || this.userStopped) {
      return;
    }
    this.autoStarted = true;
    setTimeout(() => {
      if (!this.running && !this.userStopped) {
        this.start();
      }
    }, 300);
  }

  start(): void {
    const config = this.currentConfig();
    if (!config) {
      return;
    }
    this.userStopped = false;
    this.running = true;
    this.snapshot.running = true;
    this.snapshot.lastRecoverReason = '用户或自动启动';
    this.snapshot.detailText = '正在启动后台无线 HDC 中继';
    this.logInfo('start relay runtime');
    this.emit();
    void this.startBackgroundRunning();
    this.ensureWatchdog();
    this.tunnel.start(config);
  }

  stop(): void {
    this.userStopped = true;
    this.running = false;
    this.snapshot.running = false;
    this.snapshot.lastRecoverReason = '用户停止';
    this.logInfo('stop relay runtime');
    this.tunnel.stop();
    void this.stopBackgroundRunning();
    this.emit();
  }

  recoverNow(reason: string = '手动恢复'): void {
    if (this.userStopped) {
      return;
    }
    const config = this.currentConfig();
    if (!config) {
      return;
    }
    this.running = true;
    this.snapshot.running = true;
    this.snapshot.detailText = `${reason}，正在恢复中继`;
    this.lastRestartAt = Date.now();
    this.snapshot.restartCount += 1;
    this.snapshot.lastRecoverReason = reason;
    this.logInfo(`recover relay runtime, reason=${reason}, count=${this.snapshot.restartCount}`);
    this.emit();
    void this.startBackgroundRunning();
    this.tunnel.restart(config);
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer >= 0) {
      return;
    }
    this.watchdogTimer = setInterval(() => {
      this.ensureTunnelHealthy();
    }, 10000);
  }

  private ensureTunnelHealthy(): void {
    if (this.userStopped) {
      return;
    }
    const now = Date.now();
    this.snapshot.lastHealthCheckAt = now;
    this.emitHealthLogIfNeeded(now);
    this.ensureBackgroundRunningIfNeeded(now);
    this.updateTransferObservation(now);
    if (!this.running && this.snapshot.stateText !== '已停止') {
      this.recoverNow('检测到中继运行状态异常');
      return;
    }
    const stateAgeMs = now - this.stateChangedAt;
    if (!this.shouldRestartTunnel(stateAgeMs)) {
      return;
    }
    if (now - this.lastRestartAt < 15000) {
      return;
    }
    this.recoverNow(`检测到状态停留过久：${this.snapshot.stateText}`);
  }

  private shouldRestartTunnel(stateAgeMs: number): boolean {
    if (this.snapshot.stateText === '已停止' || this.snapshot.stateText === '错误') {
      return true;
    }
    if (this.snapshot.stateText === '连接中' && stateAgeMs > 30000) {
      return true;
    }
    if (this.snapshot.stateText === '重连中' && stateAgeMs > 30000) {
      return true;
    }
    return false;
  }

  private ensureBackgroundRunningIfNeeded(now: number): void {
    if (!this.running || this.userStopped || this.context === null) {
      return;
    }
    if (this.backgroundRunning && now - this.lastBackgroundEnsureAt < 60000) {
      return;
    }
    if (!this.backgroundRunning || now - this.lastBackgroundEnsureAt >= 60000) {
      this.lastBackgroundEnsureAt = now;
      void this.startBackgroundRunning();
    }
  }

  private updateTransferObservation(now: number): void {
    const currentBytes = this.snapshot.relayToHdcdBytes + this.snapshot.hdcdToRelayBytes;
    if (this.snapshot.stateText !== '转发中') {
      this.lastObservedTransferBytes = currentBytes;
      this.lastObservedTransferAt = now;
      return;
    }
    if (currentBytes !== this.lastObservedTransferBytes) {
      this.lastObservedTransferBytes = currentBytes;
      this.lastObservedTransferAt = now;
    }
  }

  private currentConfig(): HdcRelayConfig | null {
    const relayPort = Number(this.snapshot.relayPort);
    const hdcdPort = Number(this.snapshot.hdcdPort);
    if (this.snapshot.relayHost.trim().length === 0) {
      this.snapshot.stateText = '错误';
      this.snapshot.detailText = '请先填写 Relay 地址';
      this.emit();
      return null;
    }
    if (!Number.isFinite(relayPort) || relayPort <= 0 || !Number.isFinite(hdcdPort) || hdcdPort <= 0) {
      this.snapshot.stateText = '错误';
      this.snapshot.detailText = '端口必须是有效数字';
      this.emit();
      return null;
    }
    return {
      relayHost: this.snapshot.relayHost.trim(),
      relayPort,
      deviceId: this.snapshot.deviceId.trim().length > 0 ? this.snapshot.deviceId.trim() : 'default',
      token: this.snapshot.token,
      hdcdHost: this.snapshot.hdcdHost.trim().length > 0 ? this.snapshot.hdcdHost.trim() : '127.0.0.1',
      hdcdPort
    };
  }

  private async startBackgroundRunning(): Promise<void> {
    if (this.backgroundRunning || this.context === null) {
      return;
    }
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{
          bundleName: 'com.codex.remote.hdc.helper',
          abilityName: 'EntryAbility'
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 11078,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      await backgroundTaskManager.startBackgroundRunning(
        this.context,
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
        agent
      );
      this.backgroundRunning = true;
      this.snapshot.backgroundRunning = true;
      this.lastBackgroundEnsureAt = Date.now();
      this.logInfo('background running granted');
      this.emit();
    } catch (error) {
      this.snapshot.detailText = `后台保活申请失败：${this.errorText(error)}。中继仍会尝试运行，请保持助手在前台。`;
      this.logError(`background running failed: ${this.errorText(error)}`);
      this.emit();
    }
  }

  private async stopBackgroundRunning(): Promise<void> {
    if (!this.backgroundRunning || this.context === null) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(this.context);
    } catch (_) {
    }
    this.backgroundRunning = false;
    this.snapshot.backgroundRunning = false;
    this.logInfo('background running stopped');
    this.emit();
  }

  private registerBackgroundCancelListener(): void {
    if (this.backgroundCancelListenerRegistered) {
      return;
    }
    try {
      backgroundTaskManager.on('continuousTaskCancel', this.backgroundCancelCallback);
      this.backgroundCancelListenerRegistered = true;
      this.logInfo('background cancel listener registered');
    } catch (error) {
      this.logError(`register background cancel listener failed: ${this.errorText(error)}`);
    }
  }

  private emitHealthLogIfNeeded(now: number): void {
    if (now - this.lastEmitHealthLogAt < 30000) {
      return;
    }
    this.lastEmitHealthLogAt = now;
    this.logInfo(`health state=${this.snapshot.stateText}, running=${this.running}, background=${this.backgroundRunning}, restart=${this.snapshot.restartCount}`);
  }

  private emit(): void {
    const value = this.cloneSnapshot();
    for (let index = 0; index < this.listeners.length; index += 1) {
      this.listeners[index](value);
    }
  }

  private cloneSnapshot(): RelayRuntimeSnapshot {
    return {
      relayHost: this.snapshot.relayHost,
      relayPort: this.snapshot.relayPort,
      deviceId: this.snapshot.deviceId,
      token: this.snapshot.token,
      hdcdHost: this.snapshot.hdcdHost,
      hdcdPort: this.snapshot.hdcdPort,
      running: this.snapshot.running,
      stateText: this.snapshot.stateText,
      detailText: this.snapshot.detailText,
      relayToHdcdBytes: this.snapshot.relayToHdcdBytes,
      hdcdToRelayBytes: this.snapshot.hdcdToRelayBytes,
      backgroundRunning: this.snapshot.backgroundRunning,
      lastPairedAt: this.snapshot.lastPairedAt,
      lastTransferAt: this.snapshot.lastTransferAt,
      lastHealthCheckAt: this.snapshot.lastHealthCheckAt,
      restartCount: this.snapshot.restartCount,
      lastRecoverReason: this.snapshot.lastRecoverReason,
      foreground: this.snapshot.foreground,
      healthTier: this.healthTier(),
      recommendedAction: this.recommendedAction()
    };
  }

  private healthTier(): string {
    if (this.userStopped || this.snapshot.stateText === '已停止') {
      return 'offline';
    }
    if (this.snapshot.stateText === '错误') {
      return 'error';
    }
    if (this.snapshot.stateText === '连接中' || this.snapshot.stateText === '重连中') {
      return 'connecting';
    }
    if (this.snapshot.stateText === '等待电脑') {
      return this.backgroundRunning ? 'standby_background' : 'standby_foreground';
    }
    if (this.snapshot.stateText === '已配对') {
      return 'paired';
    }
    if (this.snapshot.stateText === '转发中') {
      return this.backgroundRunning ? 'forwarding_background' : 'forwarding_foreground';
    }
    return 'unknown';
  }

  private recommendedAction(): string {
    const tier = this.healthTier();
    if (tier === 'offline') {
      return 'start';
    }
    if (tier === 'error' || tier === 'connecting') {
      return 'recover';
    }
    if (tier === 'standby_foreground' || tier === 'forwarding_foreground') {
      return 'enable_background';
    }
    return 'none';
  }

  private logInfo(message: string): void {
    hilog.info(0x0000, 'HdcRelayHelper', '%{public}s', message);
  }

  private logError(message: string): void {
    hilog.error(0x0000, 'HdcRelayHelper', '%{public}s', message);
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

  private cancelReasonText(reason: number): string {
    switch (reason) {
      case backgroundTaskManager.ContinuousTaskCancelReason.USER_CANCEL:
        return '用户取消';
      case backgroundTaskManager.ContinuousTaskCancelReason.SYSTEM_CANCEL:
        return '系统取消';
      case backgroundTaskManager.ContinuousTaskCancelReason.USER_CANCEL_REMOVE_NOTIFICATION:
        return '用户移除通知';
      case backgroundTaskManager.ContinuousTaskCancelReason.SYSTEM_CANCEL_DATA_TRANSFER_LOW_SPEED:
        return '数据传输速率过低';
      case backgroundTaskManager.ContinuousTaskCancelReason.SYSTEM_CANCEL_AUDIO_PLAYBACK_NOT_USE_AVSESSION:
        return '音频任务未接入 AVSession';
      case backgroundTaskManager.ContinuousTaskCancelReason.SYSTEM_CANCEL_AUDIO_PLAYBACK_NOT_RUNNING:
        return '音频任务未播放';
      default:
        return `未知原因 ${reason}`;
    }
  }
}

export const RelayRuntime = new RelayRuntimeService();
