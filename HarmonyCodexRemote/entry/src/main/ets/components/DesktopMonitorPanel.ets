import { StandbyMonitorSnapshot } from '../model/StandbyMonitorModels';

const ENERGY_SEGMENT_COUNT: number = 10;
const ENERGY_SEGMENTS: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

@ComponentV2
export struct DesktopMonitorPanel {
  @Param @Require snapshot: StandbyMonitorSnapshot;
  @Param landscape: boolean = true;
  @Param charging: boolean = false;
  @Param keepScreenOn: boolean = false;
  @Param batteryPercent: number = 0;
  @Event onClose: () => void = () => {};
  @Event onRefresh: () => void = () => {};
  private sessionScroller: Scroller = new Scroller();

  build() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.landscape) {
        this.LandscapeLayout()
      } else {
        this.PortraitLayout()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#020305')
  }

  @Builder
  private LandscapeLayout() {
    Column({ space: 16 }) {
      this.Header()
      Row({ space: 22 }) {
        if (this.snapshot.mirrored) {
          this.SessionPanel()
          this.StatusPanel()
        } else {
          this.StatusPanel()
          this.SessionPanel()
        }
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding({ left: 28, right: 28, top: 18, bottom: 22 })
  }

  @Builder
  private PortraitLayout() {
    Column({ space: 14 }) {
      this.Header()
      this.StatusPanel()
      this.SessionPanel()
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 16, bottom: 20 })
  }

  @Builder
  private Header() {
    if (this.landscape) {
      Row({ space: 10 }) {
        this.IdentityBlock()
        Blank()
        this.PowerStatus()
        this.RefreshButton()
        this.CloseButton()
      }
      .width('100%')
      .height(54)
      .alignItems(VerticalAlign.Center)
      .translate({ x: this.fixedRegionShiftX(), y: this.fixedRegionShiftY() })
    } else {
      Column({ space: 8 }) {
        Row({ space: 8 }) {
          this.IdentityBlock()
          Blank()
          this.CloseButton()
        }
        .width('100%')
        .height(38)

        Row({ space: 8 }) {
          this.PowerStatus()
          Blank()
          this.RefreshButton()
        }
        .width('100%')
        .height(34)
      }
      .width('100%')
      .translate({ x: this.fixedRegionShiftX(), y: this.fixedRegionShiftY() })
    }
  }

  @Builder
  private IdentityBlock() {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        Row({ space: 1 }) {
          Text('•')
            .fontSize(this.landscape ? 13 : 12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#9FD8FF')
            .maxLines(1)
          Text('ᴗ')
            .fontSize(this.landscape ? 14 : 13)
            .fontWeight(FontWeight.Bold)
            .fontColor('#9FD8FF')
            .maxLines(1)
          Text('•')
            .fontSize(this.landscape ? 13 : 12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#9FD8FF')
            .maxLines(1)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
      }
      .width(this.landscape ? 48 : 40)
      .height(this.landscape ? 48 : 40)
      .borderRadius(this.landscape ? 24 : 20)
      .backgroundColor('#0B1821')
      .border({ width: 1, color: '#15374B' })

      Column({ space: 2 }) {
        Text('Codex 小夜灯')
          .fontSize(this.landscape ? 21 : 18)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EDF5FA')
        Text(this.headerSubtitle())
          .fontSize(this.landscape ? 11 : 10)
          .fontColor('#687581')
      }
      .alignItems(HorizontalAlign.Start)
    }
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private RefreshButton() {
    Button('刷新')
      .height(34)
      .padding({ left: 12, right: 12 })
      .fontSize(11)
      .fontColor('#98A6B3')
      .backgroundColor('#0A0E12')
      .border({ width: 1, color: '#202932' })
      .borderRadius(17)
      .onClick(() => {
        this.onRefresh();
      })
  }

  @Builder
  private CloseButton() {
    Button('关闭')
      .height(34)
      .padding({ left: 12, right: 12 })
      .fontSize(11)
      .fontColor('#D7E1E8')
      .backgroundColor('#11171D')
      .border({ width: 1, color: '#2B3640' })
      .borderRadius(17)
      .onClick(() => {
        this.onClose();
      })
  }

  @Builder
  private PowerStatus() {
    Row({ space: 6 }) {
      Circle()
        .width(6)
        .height(6)
        .fill(this.keepScreenOn ? '#4ED69B' : '#D4A85E')
      Text(this.keepScreenOn ? '始终常亮' : '正在启用常亮')
        .fontSize(10)
        .fontColor(this.keepScreenOn ? '#8CDDB9' : '#C5A56E')
    }
    .height(34)
    .padding({ left: 11, right: 11 })
    .backgroundColor(this.keepScreenOn ? '#081812' : '#171208')
    .border({
      width: 1,
      color: this.keepScreenOn ? '#174B36' : '#4A3818'
    })
    .borderRadius(17)
  }

  @Builder
  private StatusPanel() {
    Column({ space: this.landscape ? 13 : 10 }) {
      Column({ space: 5 }) {
        Text(this.snapshot.mainStatus)
          .fontSize(this.landscape ? 30 : 23)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EAF2F7')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(this.snapshot.summaryText)
          .fontSize(this.landscape ? 13 : 11)
          .fontColor('#74818D')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')

      Row({ space: 8 }) {
        this.CountBadge(
          () => `${this.snapshot.runningCount}`,
          () => '进行中',
          '#5FC7FF'
        )
        this.CountBadge(
          () => `${this.endedSessionCount()}`,
          () => this.snapshot.unreadCount > 0 ? `已结束 · ${this.snapshot.unreadCount} 未读` : '已结束',
          '#74D7A5'
        )
      }
      .width('100%')

      this.QuotaItem(
        this.snapshot.usagePrimaryLabel,
        this.snapshot.usagePrimaryValue,
        this.snapshot.usagePrimaryPercent,
        '#5CB8F2'
      )
      this.QuotaItem(
        this.snapshot.usageSecondaryLabel,
        this.snapshot.usageSecondaryValue,
        this.snapshot.usageSecondaryPercent,
        '#A68AF7'
      )

      Row({ space: 6 }) {
        Circle()
          .width(5)
          .height(5)
          .fill(this.snapshot.connected ? '#4ED69B' : '#5E6670')
        Text(this.updatedTimeText())
          .fontSize(10)
          .fontColor('#59636E')
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width(this.landscape ? '42%' : '100%')
    .height(this.landscape ? '100%' : 'auto')
    .padding(this.landscape ? { right: 8 } : 0)
    .translate({ x: this.fixedRegionShiftX(), y: this.fixedRegionShiftY() })
  }

  @Builder
  private CountBadge(value: () => string, label: () => string, color: string) {
    Row({ space: 10 }) {
      Text(value())
        .fontSize(this.landscape ? 28 : 22)
        .fontWeight(FontWeight.Bold)
        .fontColor(color)
      Text(label())
        .fontSize(this.landscape ? 12 : 11)
        .fontColor('#74818D')
    }
    .layoutWeight(1)
    .height(this.landscape ? 58 : 48)
    .padding({ left: 15, right: 15 })
    .backgroundColor('#091017')
    .border({ width: 1, color: '#1A2B38' })
    .borderRadius(16)
  }

  @Builder
  private SessionPanel() {
    Column({ space: 11 }) {
      Text(this.sessionPanelTitle())
        .fontSize(this.landscape ? 14 : 13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#8995A2')

      if (this.needsAttention()) {
        this.AttentionStrip()
      }

      if (this.monitoredIndexes().length === 0) {
        Column({ space: 7 }) {
          Text('晚安，暂时没有新动态')
            .fontSize(this.landscape ? 20 : 17)
            .fontColor('#98A4AF')
          Text('会话开始或结束后会在 10 秒内更新')
            .fontSize(this.landscape ? 12 : 11)
            .fontColor('#56616C')
            .textAlign(TextAlign.Center)
        }
        .justifyContent(FlexAlign.Center)
        .layoutWeight(1)
        .width('100%')
      } else {
        List({ space: 10, scroller: this.sessionScroller }) {
          ForEach(this.monitoredIndexes(), (index: number) => {
            ListItem() {
              this.SessionRow(index)
            }
          }, (index: number) => `${this.snapshot.sessionIds[index] ?? index}`)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Auto)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width(this.landscape ? '58%' : '100%')
    .height(this.landscape ? '100%' : 'auto')
    .layoutWeight(this.landscape ? 0 : 1)
    .padding(this.landscape ? { left: 8 } : { top: 6 })
  }

  @Builder
  private AttentionStrip() {
    Row({ space: 10 }) {
      Stack({ alignContent: Alignment.Center }) {
        Circle()
          .width(18)
          .height(18)
          .fill(this.snapshot.connected ? '#D89B42' : '#D76868')
        Text('!')
          .fontSize(11)
          .fontWeight(FontWeight.Bold)
          .fontColor('#071017')
      }
      .width(22)
      .height(22)

      Column({ space: 2 }) {
        Text(this.attentionTitle())
          .fontSize(this.landscape ? 13 : 12)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.snapshot.connected ? '#F0C078' : '#F08C8C')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.attentionDetail())
          .fontSize(this.landscape ? 10 : 9)
          .fontColor('#8B7764')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Text(this.attentionBadge())
        .fontSize(10)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.snapshot.connected ? '#E2AE5C' : '#E07979')
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .backgroundColor(this.snapshot.connected ? '#2A1E0E' : '#2A1114')
        .borderRadius(10)
    }
    .width('100%')
    .height(this.landscape ? 48 : 50)
    .padding({ left: 12, right: 12 })
    .backgroundColor(this.snapshot.connected ? '#141008' : '#16090B')
    .border({
      width: 1,
      color: this.snapshot.connected ? '#5A3C16' : '#5B2228'
    })
    .borderRadius(14)
  }

  @Builder
  private SessionRow(index: number) {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        Circle()
          .width(14)
          .height(14)
          .fill(this.kindColor(this.snapshot.sessionKinds[index] ?? 'recent'))
        if (this.snapshot.sessionKinds[index] === 'running') {
          Circle()
            .width(5)
            .height(5)
            .fill('#020305')
        }
      }
      .width(18)

      Column({ space: 4 }) {
        Text(this.snapshot.sessionTitles[index] ?? '未命名会话')
          .fontSize(this.landscape ? 17 : 16)
          .fontWeight(FontWeight.Bold)
          .fontColor('#E1E8EE')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${this.snapshot.sessionProjects[index] ?? '未归类'} · ${this.snapshot.sessionStates[index] ?? ''}`)
          .fontSize(this.landscape ? 11 : 10)
          .fontColor('#606B76')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Text(this.snapshot.sessionDetails[index] ?? '')
        .fontSize(this.landscape ? 11 : 10)
        .fontColor('#71808D')
        .maxLines(1)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .backgroundColor('#101820')
        .borderRadius(10)
    }
    .width('100%')
    .height(this.landscape ? 68 : 70)
    .padding({ left: 15, right: 15 })
    .borderRadius(15)
    .backgroundColor('#091017')
    .border({
      width: 1,
      color: this.snapshot.sessionKinds[index] === 'unread' ? '#3A315E' : '#15374B'
    })
  }

  @Builder
  private QuotaItem(label: string, value: string, percent: number, color: string) {
    Column({ space: 10 }) {
      Row() {
        Column({ space: 3 }) {
          Text(label)
            .fontSize(this.landscape ? 13 : 12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#DCE7EE')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(value)
            .fontSize(this.landscape ? 11 : 10)
            .fontColor('#71808D')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Blank()
        Row({ space: 4 }) {
          Text(this.quotaPercentText(percent, value))
            .fontSize(this.landscape ? 28 : 24)
            .fontWeight(FontWeight.Bold)
            .fontColor(color)
          if (this.hasQuotaPercent(value)) {
            Text('可用')
              .fontSize(10)
              .fontColor('#6D7A86')
          }
        }
        .alignItems(VerticalAlign.Bottom)
      }
      .width('100%')

      this.EnergyBar(percent, value, color)
    }
    .width('100%')
    .height(this.landscape ? 94 : 88)
    .padding({ left: 14, right: 14, top: 11, bottom: 12 })
    .backgroundColor('#080E14')
    .border({ width: 1, color: '#182A37' })
    .borderRadius(16)
  }

  @Builder
  private EnergyBar(percent: number, value: string, color: string) {
    Row({ space: this.landscape ? 5 : 4 }) {
      ForEach(ENERGY_SEGMENTS, (segment: number) => {
        Row()
          .layoutWeight(1)
          .height(this.landscape ? 14 : 12)
          .borderRadius(4)
          .backgroundColor(segment < this.filledEnergySegments(percent, value) ? color : '#17212A')
          .opacity(segment < this.filledEnergySegments(percent, value) ? 0.9 : 0.72)
      }, (segment: number) => `${segment}`)
    }
    .width('100%')
    .height(this.landscape ? 14 : 12)
  }

  private monitoredIndexes(): number[] {
    const runningIndexes: number[] = [];
    const endedIndexes: number[] = [];
    this.snapshot.sessionKinds.forEach((kind: string, index: number) => {
      if (kind === 'running' || kind === 'unread' || kind === 'recent') {
        if (kind === 'running') {
          runningIndexes.push(index);
        } else {
          endedIndexes.push(index);
        }
      }
    });
    return endedIndexes.concat(runningIndexes);
  }

  private needsAttention(): boolean {
    return !this.snapshot.connected || this.attentionCount() > 0;
  }

  private attentionCount(): number {
    return this.attentionStateCount('等待批准')
      + this.attentionStateCount('等待回答')
      + this.attentionStateCount('失败');
  }

  private attentionStateCount(label: string): number {
    let count = 0;
    this.snapshot.sessionStates.forEach((state: string) => {
      if (state === label) {
        count += 1;
      }
    });
    return count;
  }

  private attentionTitle(): string {
    const count = this.attentionCount();
    if (!this.snapshot.connected) {
      return count > 0 ? `连接异常 · ${count} 个会话待处理` : '连接异常';
    }
    return `${count} 个会话需要你处理`;
  }

  private attentionDetail(): string {
    const parts: string[] = [];
    const approvalCount = this.attentionStateCount('等待批准');
    const inputCount = this.attentionStateCount('等待回答');
    const failureCount = this.attentionStateCount('失败');
    if (approvalCount > 0) {
      parts.push(`等待批准 ${approvalCount}`);
    }
    if (inputCount > 0) {
      parts.push(`等待回答 ${inputCount}`);
    }
    if (failureCount > 0) {
      parts.push(`执行失败 ${failureCount}`);
    }
    if (!this.snapshot.connected) {
      parts.push('正在显示最近一次状态');
    }
    return parts.join(' · ');
  }

  private attentionBadge(): string {
    if (!this.snapshot.connected) {
      return '离线';
    }
    return `${this.attentionCount()} 项`;
  }

  private endedSessionCount(): number {
    return Math.max(0, this.snapshot.totalCount - this.snapshot.runningCount);
  }

  private sessionPanelTitle(): string {
    if (this.snapshot.runningCount > 0 && this.endedSessionCount() > 0) {
      return '正在运行与已结束';
    }
    if (this.snapshot.runningCount > 0) {
      return '正在运行';
    }
    if (this.endedSessionCount() > 0) {
      return '最近已结束';
    }
    return '会话实时状态';
  }

  private headerSubtitle(): string {
    return `${this.batteryPercent}% 电量 · 10 秒刷新 · 跟随系统亮度`;
  }

  private hasQuotaPercent(value: string): boolean {
    return /\d+(?:\.\d+)?\s*%/.test(value);
  }

  private quotaPercentText(percent: number, value: string): string {
    return this.hasQuotaPercent(value) ? `${Math.max(0, Math.min(100, percent))}%` : '--';
  }

  private filledEnergySegments(percent: number, value: string): number {
    if (!this.hasQuotaPercent(value)) {
      return 0;
    }
    const safePercent = Math.max(0, Math.min(100, percent));
    if (safePercent === 0) {
      return 0;
    }
    return Math.max(1, Math.round((safePercent / 100) * ENERGY_SEGMENT_COUNT));
  }

  private kindColor(kind: string): string {
    if (kind === 'running') {
      return '#5FC7FF';
    }
    if (kind === 'unread') {
      return '#B39CFF';
    }
    return '#74D7A5';
  }

  private updatedTimeText(): string {
    const timestamp = Date.parse(this.snapshot.updatedAt);
    if (!Number.isFinite(timestamp)) {
      return this.snapshot.connected ? '已连接' : '离线快照';
    }
    const date = new Date(timestamp);
    const hour = `${date.getHours()}`.padStart(2, '0');
    const minute = `${date.getMinutes()}`.padStart(2, '0');
    const second = `${date.getSeconds()}`.padStart(2, '0');
    return `${hour}:${minute}:${second} 同步`;
  }

  private fixedRegionShiftX(): number {
    const values: number[] = [-6, 6, 6, -6];
    return values[this.snapshot.shiftIndex % values.length];
  }

  private fixedRegionShiftY(): number {
    const values: number[] = [-4, -4, 4, 4];
    return values[this.snapshot.shiftIndex % values.length];
  }
}
