import { HdcRelayState } from '../services/HdcRelayTunnel';
import { RelayRuntime, RelayRuntimeSnapshot } from '../services/RelayRuntime';
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_HDCD_HOST,
  DEFAULT_HDCD_PORT,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  DEFAULT_RELAY_TOKEN
} from '../config/RelayConfig';

@Entry
@Component
struct Index {
  @State relayHost: string = DEFAULT_RELAY_HOST;
  @State relayPort: string = DEFAULT_RELAY_PORT;
  @State deviceId: string = DEFAULT_DEVICE_ID;
  @State token: string = DEFAULT_RELAY_TOKEN;
  @State hdcdHost: string = DEFAULT_HDCD_HOST;
  @State hdcdPort: string = DEFAULT_HDCD_PORT;
  @State running: boolean = false;
  @State stateText: HdcRelayState = '已停止';
  @State detailText: string = '等待自动启动';
  @State relayToHdcdBytes: number = 0;
  @State hdcdToRelayBytes: number = 0;
  @State backgroundRunning: boolean = false;
  @State lastPairedAt: number = 0;
  @State lastTransferAt: number = 0;
  @State lastHealthCheckAt: number = 0;
  @State restartCount: number = 0;
  @State lastRecoverReason: string = '尚未恢复';
  @State foreground: boolean = true;
  @State healthTier: string = 'offline';
  @State recommendedAction: string = 'start';

  private readonly runtimeListener: (snapshot: RelayRuntimeSnapshot) => void = (snapshot: RelayRuntimeSnapshot) => {
    this.applySnapshot(snapshot);
  };

  aboutToAppear(): void {
    RelayRuntime.subscribe(this.runtimeListener);
    RelayRuntime.autoStart();
  }

  aboutToDisappear(): void {
    RelayRuntime.unsubscribe(this.runtimeListener);
  }

  build() {
    Scroll() {
      Column({ space: 14 }) {
        this.Header()
        this.StatusPanel()
        this.ConfigPanel()
        this.ControlPanel()
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 18, bottom: 28 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F7F8FA')
    .scrollBar(BarState.Auto)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  Header() {
    Column({ space: 5 }) {
      Text('HDC 中继助手')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17202A')
      Text('后台保持手机在线，给电脑远程安装、截屏和抓日志')
        .fontSize(13)
        .fontColor('#68717D')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  @Builder
  StatusPanel() {
    Column({ space: 8 }) {
      Row() {
        Text(this.displayStateText())
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF')
          .padding({ left: 12, right: 12, top: 6, bottom: 6 })
          .backgroundColor(this.statusColor())
          .borderRadius(6)
        Blank()
        Text(this.connectionBadgeText())
          .fontSize(13)
          .fontColor('#68717D')
      }
      .width('100%')

      Text(this.displayDetailText())
        .fontSize(13)
        .fontColor('#17202A')
        .width('100%')
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text(this.healthHintText())
        .fontSize(12)
        .fontColor(this.recommendedAction === 'none' ? '#1A7F37' : '#9A6700')
        .width('100%')

      Text(`电脑到 hdcd：${this.relayToHdcdBytes} B    hdcd 到电脑：${this.hdcdToRelayBytes} B`)
        .fontSize(12)
        .fontColor('#68717D')
        .width('100%')

      Column({ space: 4 }) {
        Text(`巡检：${this.relativeTimeText(this.lastHealthCheckAt)}    恢复：${this.restartCount} 次`)
          .fontSize(12)
          .fontColor('#68717D')
          .width('100%')
        Text(`最近原因：${this.lastRecoverReason}`)
          .fontSize(12)
          .fontColor('#68717D')
          .width('100%')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  @Builder
  ConfigPanel() {
    Column({ space: 10 }) {
      this.LabelInput('Relay 地址', this.relayHost, '公网服务器 IP 或域名', (value: string) => {
        this.relayHost = value.trim();
        RelayRuntime.updateConfig({ relayHost: this.relayHost });
      })
      this.LabelInput('Relay 端口', this.relayPort, '19078', (value: string) => {
        this.relayPort = value.trim();
        RelayRuntime.updateConfig({ relayPort: this.relayPort });
      })
      this.LabelInput('设备标识', this.deviceId, '与电脑配置一致', (value: string) => {
        this.deviceId = value.trim();
        RelayRuntime.updateConfig({ deviceId: this.deviceId });
      })
      this.LabelInput('访问令牌', this.token, '与电脑配置一致', (value: string) => {
        this.token = value.trim();
        RelayRuntime.updateConfig({ token: this.token });
      }, true)
      this.LabelInput('本机 hdcd 地址', this.hdcdHost, '127.0.0.1', (value: string) => {
        this.hdcdHost = value.trim();
        RelayRuntime.updateConfig({ hdcdHost: this.hdcdHost });
      })
      this.LabelInput('本机 hdcd 端口', this.hdcdPort, '10178', (value: string) => {
        this.hdcdPort = value.trim();
        RelayRuntime.updateConfig({ hdcdPort: this.hdcdPort });
      })
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  @Builder
  LabelInput(label: string, value: string, placeholder: string, onChange: (value: string) => void, password: boolean = false) {
    Column({ space: 5 }) {
      Text(label)
        .fontSize(12)
        .fontColor('#68717D')
      TextInput({ text: value, placeholder })
        .height(42)
        .fontSize(14)
        .backgroundColor('#F7F8FA')
        .borderRadius(6)
        .type(password ? InputType.Password : InputType.Normal)
        .enabled(!this.running)
        .onChange(onChange)
    }
    .width('100%')
  }

  @Builder
  ControlPanel() {
    Row({ space: 10 }) {
      Button(this.running ? '停止中继' : '启动中继')
        .height(44)
        .layoutWeight(1)
        .fontSize(15)
        .fontColor('#FFFFFF')
        .backgroundColor(this.running ? '#D1242F' : '#1F6FEB')
        .onClick(() => {
          if (this.running) {
            RelayRuntime.stop();
            return;
          }
          RelayRuntime.start();
        })

      Button('恢复')
        .height(44)
        .width(84)
        .fontSize(15)
        .fontColor('#17202A')
        .backgroundColor('#FFFFFF')
        .borderColor('#D0D7DE')
        .borderWidth(1)
        .onClick(() => {
          RelayRuntime.recoverNow('用户点击恢复');
        })
    }
    .width('100%')
  }

  private applySnapshot(snapshot: RelayRuntimeSnapshot): void {
    this.relayHost = snapshot.relayHost;
    this.relayPort = snapshot.relayPort;
    this.deviceId = snapshot.deviceId;
    this.token = snapshot.token;
    this.hdcdHost = snapshot.hdcdHost;
    this.hdcdPort = snapshot.hdcdPort;
    this.running = snapshot.running;
    this.stateText = snapshot.stateText;
    this.detailText = snapshot.detailText;
    this.relayToHdcdBytes = snapshot.relayToHdcdBytes;
    this.hdcdToRelayBytes = snapshot.hdcdToRelayBytes;
    this.backgroundRunning = snapshot.backgroundRunning;
    this.lastPairedAt = snapshot.lastPairedAt;
    this.lastTransferAt = snapshot.lastTransferAt;
    this.lastHealthCheckAt = snapshot.lastHealthCheckAt;
    this.restartCount = snapshot.restartCount;
    this.lastRecoverReason = snapshot.lastRecoverReason;
    this.foreground = snapshot.foreground;
    this.healthTier = snapshot.healthTier;
    this.recommendedAction = snapshot.recommendedAction;
  }

  private connectionBadgeText(): string {
    if (this.healthTier === 'forwarding_background') {
      return '转发中 · 后台保活';
    }
    if (this.healthTier === 'standby_background') {
      return '在线待命 · 后台保活';
    }
    if (this.isRecentlyPaired()) {
      return this.backgroundRunning ? '电脑已连接 · 后台保活中' : '电脑已连接';
    }
    if (this.backgroundRunning) {
      return this.foreground ? '前台运行 · 后台保活已申请' : '后台保活中';
    }
    return this.running ? '前台运行中' : '未运行';
  }

  private displayDetailText(): string {
    if (this.isRecentlyPaired() && this.stateText === '等待电脑') {
      return '电脑 HDC 已连接，当前通道被 HDC 占用，正在保持转发';
    }
    if (this.stateText === '等待电脑') {
      return '手机已连接 Relay，后台待命中；电脑安装、截屏或抓日志时会自动接入';
    }
    return this.detailText;
  }

  private healthHintText(): string {
    if (this.recommendedAction === 'none') {
      return '链路守护正常，空闲时不会重复重启';
    }
    if (this.recommendedAction === 'start') {
      return '中继未运行，打开后会自动尝试启动';
    }
    if (this.recommendedAction === 'recover') {
      return '守护器检测到异常，正在退避重连';
    }
    if (this.recommendedAction === 'enable_background') {
      return '建议保持后台保活授权，切后台后会自动续保';
    }
    return '正在检查链路状态';
  }

  private displayStateText(): string {
    if (this.isRecentlyPaired() && this.stateText === '等待电脑') {
      return '转发中';
    }
    if (this.stateText === '等待电脑') {
      return '在线待命';
    }
    return this.stateText;
  }

  private isRecentlyPaired(): boolean {
    const lastActiveAt = Math.max(this.lastPairedAt, this.lastTransferAt);
    return lastActiveAt > 0 && Date.now() - lastActiveAt < 90000;
  }

  private relativeTimeText(timestamp: number): string {
    if (timestamp <= 0) {
      return '尚未巡检';
    }
    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSeconds < 5) {
      return '刚刚';
    }
    if (diffSeconds < 60) {
      return `${diffSeconds} 秒前`;
    }
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) {
      return `${diffMinutes} 分钟前`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    return `${diffHours} 小时前`;
  }

  private statusColor(): string {
    const displayedState = this.displayStateText();
    if (displayedState === '转发中' || displayedState === '已配对' || displayedState === '在线待命') {
      return '#1A7F37';
    }
    if (this.stateText === '错误') {
      return '#D1242F';
    }
    if (this.stateText === '等待电脑' || this.stateText === '连接中' || this.stateText === '重连中') {
      return '#9A6700';
    }
    return '#68717D';
  }
}
