let standbyMonitorStorage = new LocalStorage();

@Entry(standbyMonitorStorage)
@Component
struct StandbyMonitorCard {
  @LocalStorageProp('connected') connected: boolean = false;
  @LocalStorageProp('updatedAt') updatedAt: string = '';
  @LocalStorageProp('runtimeGeneratedAt') runtimeGeneratedAt: string = '';
  @LocalStorageProp('runtimeStale') runtimeStale: boolean = true;
  @LocalStorageProp('mainStatus') mainStatus: string = '等待连接';
  @LocalStorageProp('summaryText') summaryText: string = '正在寻找 Codex';
  @LocalStorageProp('runningCount') runningCount: number = 0;
  @LocalStorageProp('unreadCount') unreadCount: number = 0;
  @LocalStorageProp('sessionIds') sessionIds: string[] = [];
  @LocalStorageProp('sessionTitles') sessionTitles: string[] = [];
  @LocalStorageProp('sessionProjects') sessionProjects: string[] = [];
  @LocalStorageProp('sessionStates') sessionStates: string[] = [];
  @LocalStorageProp('sessionDetails') sessionDetails: string[] = [];
  @LocalStorageProp('sessionKinds') sessionKinds: string[] = [];
  @LocalStorageProp('usagePrimaryLabel') usagePrimaryLabel: string = '5 小时';
  @LocalStorageProp('usagePrimaryValue') usagePrimaryValue: string = '等待同步';
  @LocalStorageProp('usagePrimaryPercent') usagePrimaryPercent: number = 0;
  @LocalStorageProp('usageSecondaryLabel') usageSecondaryLabel: string = '每周';
  @LocalStorageProp('usageSecondaryValue') usageSecondaryValue: string = '等待同步';
  @LocalStorageProp('usageSecondaryPercent') usageSecondaryPercent: number = 0;
  @LocalStorageProp('layoutMode') layoutMode: string = 'landscape';
  @LocalStorageProp('page') page: number = 0;
  @LocalStorageProp('mirrored') mirrored: boolean = false;
  @LocalStorageProp('shiftIndex') shiftIndex: number = 0;

  build() {
    FormLink({
      action: 'router',
      abilityName: 'EntryAbility',
      params: {
        source: 'standby_monitor',
        sessionId: this.primarySessionId()
      }
    }) {
      Stack({ alignContent: Alignment.Center }) {
        if (this.isPortrait()) {
          this.PortraitMonitor()
        } else {
          this.LandscapeMonitor()
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#020305')
      .translate({ x: this.shiftX(), y: this.shiftY() })
    }
  }

  @Builder
  private LandscapeMonitor() {
    Row({ space: 18 }) {
      if (this.mirrored) {
        this.SessionPanel()
        this.StatusPanel()
      } else {
        this.StatusPanel()
        this.SessionPanel()
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 22, right: 22, top: 16, bottom: 16 })
  }

  @Builder
  private PortraitMonitor() {
    Column({ space: 10 }) {
      this.StatusPanel()
      this.SessionPanel()
    }
    .width('100%')
    .height('100%')
    .padding({ left: 16, right: 16, top: 18, bottom: 16 })
  }

  @Builder
  private StatusPanel() {
    Column({ space: this.isPortrait() ? 8 : 11 }) {
      Row({ space: 10 }) {
        Stack({ alignContent: Alignment.Center }) {
          Column({ space: 1 }) {
            Text('•ᴗ•')
              .fontSize(this.isPortrait() ? 19 : 23)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.connected ? '#8FD6FF' : '#66717E')
            Text('codex')
              .fontSize(8)
              .fontColor('#64707E')
          }
        }
        .width(this.isPortrait() ? 56 : 66)
        .height(this.isPortrait() ? 50 : 58)
        .borderRadius(17)
        .border({ width: 1, color: this.connected ? '#234A67' : '#252B33' })
        .backgroundColor('#080C11')

        Column({ space: 3 }) {
          Text('Codex 小夜灯')
            .fontSize(this.isPortrait() ? 16 : 18)
            .fontWeight(FontWeight.Bold)
            .fontColor('#EAF2F8')
          Text(this.mainStatus)
            .fontSize(this.isPortrait() ? 12 : 13)
            .fontColor(this.runningCount > 0 ? '#73C6FF' : '#8895A3')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')

      Text(this.summaryText)
        .fontSize(11)
        .fontColor('#77828E')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      this.QuotaItem(
        this.usagePrimaryLabel,
        this.usagePrimaryValue,
        this.usagePrimaryPercent,
        '#5CB8F2'
      )
      this.QuotaItem(
        this.usageSecondaryLabel,
        this.usageSecondaryValue,
        this.usageSecondaryPercent,
        '#A68AF7'
      )

      Row({ space: 6 }) {
        Circle()
          .width(5)
          .height(5)
          .fill(this.runtimeStale ? '#D8A657' : (this.connected ? '#4ED69B' : '#5E6670'))
        Text(this.updatedTimeText())
          .fontSize(9)
          .fontColor(this.runtimeStale ? '#B18A50' : '#59636E')
      }
      .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .width(this.isPortrait() ? '100%' : '36%')
    .height(this.isPortrait() ? '39%' : '100%')
    .padding(this.isPortrait() ? 0 : { right: 8 })
  }

  @Builder
  private SessionPanel() {
    Column({ space: 7 }) {
      Row() {
        Text(this.sessionPanelTitle())
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8995A2')
        Blank()
        Text(this.pageText())
          .fontSize(9)
          .fontColor('#4E5965')
      }
      .width('100%')

      if (this.sessionTitles.length === 0) {
        Column({ space: 6 }) {
          Text('晚安，暂时没有新动态')
            .fontSize(13)
            .fontColor('#98A4AF')
          Text('有任务时会在这里轻轻亮起')
            .fontSize(10)
            .fontColor('#56616C')
        }
        .justifyContent(FlexAlign.Center)
        .width('100%')
        .layoutWeight(1)
      } else {
        ForEach(this.visibleIndexes(), (index: number) => {
          this.SessionRow(index)
        }, (index: number) => `${this.sessionIds[index] ?? index}-${this.page}`)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width(this.isPortrait() ? '100%' : '64%')
    .height(this.isPortrait() ? '61%' : '100%')
    .padding(this.isPortrait() ? { top: 6 } : { left: 8 })
  }

  @Builder
  private SessionRow(index: number) {
    Row({ space: 9 }) {
      Stack({ alignContent: Alignment.Center }) {
        Circle()
          .width(10)
          .height(10)
          .fill(this.kindColor(this.sessionKinds[index] ?? 'recent'))
          .opacity(this.sessionKinds[index] === 'recent' ? 0.45 : 1)
        if (this.sessionKinds[index] === 'running') {
          Circle()
            .width(4)
            .height(4)
            .fill('#020305')
        }
      }
      .width(14)

      Column({ space: 2 }) {
        Text(this.sessionTitles[index] ?? '未命名会话')
          .fontSize(this.isPortrait() ? 12 : 13)
          .fontWeight(this.sessionKinds[index] === 'recent' ? FontWeight.Regular : FontWeight.Medium)
          .fontColor(this.sessionKinds[index] === 'recent' ? '#939DA7' : '#E1E8EE')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${this.sessionProjects[index] ?? '未归类'} · ${this.sessionStates[index] ?? '最近'}`)
          .fontSize(9)
          .fontColor('#606B76')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Text(this.sessionDetails[index] ?? '')
        .fontSize(9)
        .fontColor('#59636D')
        .maxLines(1)
    }
    .width('100%')
    .height(this.isPortrait() ? 44 : 36)
    .padding({ left: 10, right: 10 })
    .borderRadius(11)
    .backgroundColor(this.sessionKinds[index] === 'recent' ? '#05080B' : '#080D12')
    .border({
      width: this.sessionKinds[index] === 'recent' ? 0 : 1,
      color: this.sessionKinds[index] === 'unread' ? '#3A315E' : '#15374B'
    })
  }

  @Builder
  private QuotaItem(label: string, value: string, percent: number, color: string) {
    Column({ space: 4 }) {
      Row() {
        Text(label)
          .fontSize(10)
          .fontColor('#7D8995')
        Blank()
        Text(value)
          .fontSize(9)
          .fontColor('#66727D')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      Stack({ alignContent: Alignment.Start }) {
        Row()
          .height(4)
          .width('100%')
          .borderRadius(2)
          .backgroundColor('#151B21')
        Row()
          .height(4)
          .width(`${Math.max(2, Math.min(100, percent))}%`)
          .borderRadius(2)
          .backgroundColor(color)
          .opacity(0.74)
      }
      .height(4)
      .width('100%')
    }
    .width('100%')
  }

  private isPortrait(): boolean {
    return this.layoutMode === 'portrait';
  }

  private pageSize(): number {
    return this.isPortrait() ? 4 : 6;
  }

  private visibleIndexes(): number[] {
    const result: number[] = [];
    const size = this.isPortrait() ? 4 : 6;
    const pages = Math.max(1, Math.ceil(this.sessionTitles.length / size));
    const safePage = this.page % pages;
    const start = safePage * size;
    for (let index = start; index < Math.min(this.sessionTitles.length, start + size); index += 1) {
      result.push(index);
    }
    return result;
  }

  private primarySessionId(): string {
    return this.sessionIds.length > 0 ? this.sessionIds[0] : '';
  }

  private kindColor(kind: string): string {
    if (kind === 'running') {
      return '#5FC7FF';
    }
    if (kind === 'unread') {
      return '#B39CFF';
    }
    return '#66717C';
  }

  private sessionPanelTitle(): string {
    if (this.runningCount > 0 && this.unreadCount > 0) {
      return '正在运行与未读';
    }
    if (this.runningCount > 0) {
      return '正在运行';
    }
    if (this.unreadCount > 0) {
      return '已完成未读';
    }
    return '最近会话';
  }

  private pageText(): string {
    const size = this.pageSize();
    const pages = Math.max(1, Math.ceil(this.sessionTitles.length / size));
    return pages > 1 ? `${(this.page % pages) + 1}/${pages}` : '';
  }

  private updatedTimeText(): string {
    const timestamp = Date.parse(this.runtimeGeneratedAt.length > 0 ? this.runtimeGeneratedAt : this.updatedAt);
    if (!Number.isFinite(timestamp)) {
      return this.runtimeStale ? '状态可能已过期' : (this.connected ? '已连接' : '离线快照');
    }
    const date = new Date(timestamp);
    const hour = `${date.getHours()}`.padStart(2, '0');
    const minute = `${date.getMinutes()}`.padStart(2, '0');
    return this.runtimeStale ? `${hour}:${minute} · 状态可能已过期` : `${hour}:${minute} 同步`;
  }

  private shiftX(): number {
    const values: number[] = [-1, 0, 1, 1, 0, -1, -1, 0];
    return values[this.shiftIndex % values.length];
  }

  private shiftY(): number {
    const values: number[] = [0, -1, -1, 0, 1, 1, 0, 1];
    return values[this.shiftIndex % values.length];
  }
}
