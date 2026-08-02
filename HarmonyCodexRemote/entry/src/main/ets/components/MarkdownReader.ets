import {
  BaseEngine,
  EMarkdownMode,
  ENode,
  IMarkdownNodeClickEvent,
  Link,
  Markdown
} from 'fluid-markdown';
import {
  BlockedMarkdownImageServicePlugin,
  MarkdownOutlineItem,
  MarkdownReaderBlock,
  MarkdownReaderDocument
} from '../services/MarkdownDocumentService';
import { MermaidDiagram } from './MermaidDiagram';
import {
  fontScaleLabel,
  fontScalePercent,
  normalizeFontScaleMode,
  scaleFontSize
} from '../theme/AppTypography';
import { LengthMetrics } from '@kit.ArkUI';

@ComponentV2
export struct MarkdownReader {
  @Param @Require document: MarkdownReaderDocument;
  @Param darkMode: boolean = true;
  @Param fontScaleMode: string = 'standard';
  @Param landscape: boolean = false;
  @Event onClose: () => void = () => {};
  @Event onCopy: () => void = () => {};
  @Event onShare: () => void = () => {};
  @Event onOpenExternal: () => void = () => {};
  @Event onLinkClick: (href: string) => void = (_href: string) => {};
  @Event onFontScaleChange: (mode: string) => void = (_mode: string) => {};

  @Local outlineVisible: boolean = false;
  @Local moreMenuVisible: boolean = false;
  @Local activeFontScaleMode: string = 'standard';
  @Local fontRevision: number = 0;

  private scroller: Scroller = new Scroller();
  private engine: BaseEngine = new BaseEngine();
  private imagePolicyInstalled: boolean = false;

  aboutToAppear(): void {
    this.activeFontScaleMode = normalizeFontScaleMode(this.fontScaleMode);
    if (!this.imagePolicyInstalled) {
      this.engine.image.add(new BlockedMarkdownImageServicePlugin());
      this.imagePolicyInstalled = true;
    }
    this.applyMarkdownTheme();
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        this.ReaderHeader()
        Divider()
          .strokeWidth(1)
          .color(this.readerBorderColor())

        Row() {
          if (this.landscape && this.outlineVisible) {
            this.OutlinePanel()
          }

          Scroll(this.scroller) {
            Row() {
              Column({ space: 0 }) {
                ForEach(this.document.blocks, (block: MarkdownReaderBlock) => {
                  this.ReaderBlock(block)
                }, (block: MarkdownReaderBlock) => block.id)
              }
              .width('100%')
              .constraintSize({ maxWidth: this.readerMaxWidth() })
              .padding({
                left: this.landscape ? 30 : 18,
                right: this.landscape ? 30 : 18,
                top: this.landscape ? 34 : 26,
                bottom: 72
              })
            }
            .width('100%')
            .justifyContent(FlexAlign.Center)
          }
          .layoutWeight(1)
          .height('100%')
          .scrollBar(BarState.Auto)
          .edgeEffect(EdgeEffect.Spring)
        }
        .layoutWeight(1)
        .width('100%')
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.canvasColor())

      if (!this.landscape && this.outlineVisible) {
        this.PortraitOutlineOverlay()
      }

      if (this.moreMenuVisible) {
        this.MoreMenuOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.canvasColor())
  }

  @Builder
  ReaderHeader() {
    Row({ space: 8 }) {
      Button('‹')
        .width(38)
        .height(38)
        .fontSize(28)
        .fontColor(this.primaryTextColor())
        .backgroundColor(this.surfaceColor())
        .border({ width: 1, color: this.readerBorderColor() })
        .borderRadius(19)
        .onClick(() => {
          this.onClose();
        })

      Column({ space: 2 }) {
        Text(this.document.fileName)
          .fontSize(this.uiFontSize(15))
          .fontWeight(FontWeight.Bold)
          .fontColor(this.primaryTextColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(`${this.formatBytes(this.document.bytes)} · Markdown · 已下载到手机`)
          .fontSize(this.uiFontSize(10))
          .fontColor(this.secondaryTextColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      this.HeaderActionButton('目录', () => {
        this.outlineVisible = !this.outlineVisible;
        this.moreMenuVisible = false;
      })
      this.HeaderActionButton(
        `字体 ${fontScalePercent(this.activeFontScaleMode)}%`,
        () => {
          this.cycleFontScale();
        }
      )
      if (this.landscape) {
        this.HeaderActionButton('分享', () => {
          this.onShare();
        })
      }
      this.HeaderActionButton('⋯', () => {
        this.moreMenuVisible = !this.moreMenuVisible;
        this.outlineVisible = false;
      })
    }
    .width('100%')
    .height(64)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.headerColor())
  }

  @Builder
  ReaderBlock(block: MarkdownReaderBlock) {
    if (block.kind === 'mermaid') {
      MermaidDiagram({
        source: block.source,
        darkMode: this.darkMode,
        fontScaleMode: this.activeFontScaleMode,
        landscape: this.landscape
      })
        .width('100%')
    } else {
      Markdown({
        engine: this.engine,
        content: this.renderedContent(block.content),
        mode: EMarkdownMode.Normal,
        onMarkdownNodeClick: (event: IMarkdownNodeClickEvent) => {
          this.handleMarkdownNodeClick(event);
        }
      })
        .width('100%')
    }
  }

  @Builder
  HeaderActionButton(label: string, action: () => void) {
    Button(label)
      .height(34)
      .padding({ left: 10, right: 10 })
      .fontSize(this.uiFontSize(10))
      .fontColor(this.secondaryTextColor())
      .backgroundColor(this.surfaceColor())
      .border({ width: 1, color: this.readerBorderColor() })
      .borderRadius(10)
      .onClick(action)
  }

  @Builder
  OutlinePanel() {
    Column() {
      this.OutlineHeader()
      if (this.document.outline.length === 0) {
        Text('当前文档没有标题目录')
          .fontSize(this.uiFontSize(11))
          .fontColor(this.secondaryTextColor())
          .padding(16)
          .width('100%')
      } else {
        List({ space: 2 }) {
          ForEach(this.document.outline, (item: MarkdownOutlineItem) => {
            ListItem() {
              this.OutlineItem(item)
            }
          }, (item: MarkdownOutlineItem) => item.id)
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width(272)
    .height('100%')
    .backgroundColor(this.panelColor())
    .border({ width: { right: 1 }, color: this.readerBorderColor() })
  }

  @Builder
  PortraitOutlineOverlay() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.overlayColor())
        .onClick(() => {
          this.outlineVisible = false;
        })

      Column() {
        this.OutlineHeader()
        if (this.document.outline.length === 0) {
          Text('当前文档没有标题目录')
            .fontSize(this.uiFontSize(11))
            .fontColor(this.secondaryTextColor())
            .padding(16)
            .width('100%')
        } else {
          List({ space: 2 }) {
            ForEach(this.document.outline, (item: MarkdownOutlineItem) => {
              ListItem() {
                this.OutlineItem(item)
              }
            }, (item: MarkdownOutlineItem) => item.id)
          }
          .layoutWeight(1)
          .width('100%')
        }
      }
      .width('78%')
      .height('100%')
      .backgroundColor(this.panelColor())
      .shadow({ radius: 20, color: this.shadowColor(), offsetX: -6, offsetY: 0 })
    }
    .width('100%')
    .height('100%')
    .zIndex(20)
  }

  @Builder
  OutlineHeader() {
    Row() {
      Text('文档目录')
        .fontSize(this.uiFontSize(13))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.primaryTextColor())
        .layoutWeight(1)
      Button('关闭')
        .height(30)
        .fontSize(this.uiFontSize(10))
        .fontColor(this.accentColor())
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.outlineVisible = false;
        })
    }
    .width('100%')
    .height(52)
    .padding({ left: 16, right: 10 })
    .border({ width: { bottom: 1 }, color: this.readerBorderColor() })
  }

  @Builder
  OutlineItem(item: MarkdownOutlineItem) {
    Button() {
      Text(item.title)
        .fontSize(this.uiFontSize(11))
        .fontColor(this.primaryTextColor())
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .height(42)
    .padding({
      left: 12 + Math.max(0, item.level - 1) * 12,
      right: 12
    })
    .backgroundColor(Color.Transparent)
    .onClick(() => {
      this.scrollToOutlineItem(item);
      this.outlineVisible = false;
    })
  }

  @Builder
  MoreMenuOverlay() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.moreMenuVisible = false;
        })

      Column({ space: 4 }) {
        Text(`字体：${fontScaleLabel(this.activeFontScaleMode)} · ${fontScalePercent(this.activeFontScaleMode)}%`)
          .fontSize(this.uiFontSize(10))
          .fontColor(this.secondaryTextColor())
          .width('100%')
          .padding({ left: 12, top: 6, bottom: 4 })
        this.MoreMenuItem('复制全文', () => {
          this.moreMenuVisible = false;
          this.onCopy();
        })
        this.MoreMenuItem('分享文件', () => {
          this.moreMenuVisible = false;
          this.onShare();
        })
        this.MoreMenuItem('其他应用打开', () => {
          this.moreMenuVisible = false;
          this.onOpenExternal();
        })
      }
      .width(218)
      .padding(8)
      .margin({ top: 58, right: 12 })
      .backgroundColor(this.panelColor())
      .border({ width: 1, color: this.readerBorderColor() })
      .borderRadius(14)
      .shadow({ radius: 18, color: this.shadowColor(), offsetX: 0, offsetY: 6 })
    }
    .width('100%')
    .height('100%')
    .zIndex(30)
  }

  @Builder
  MoreMenuItem(label: string, action: () => void) {
    Button() {
      Text(label)
        .fontSize(this.uiFontSize(12))
        .fontColor(this.primaryTextColor())
        .width('100%')
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .height(42)
    .padding({ left: 12, right: 12 })
    .backgroundColor(this.surfaceColor())
    .borderRadius(9)
    .onClick(action)
  }

  private handleMarkdownNodeClick(event: IMarkdownNodeClickEvent): void {
    if (event.node.type !== ENode.Link) {
      return;
    }
    const link = event.node as Link;
    const href = String(link.href ?? '').trim();
    if (href.length > 0) {
      this.onLinkClick(href);
    }
  }

  private cycleFontScale(): void {
    const current = normalizeFontScaleMode(this.activeFontScaleMode);
    let next = 'standard';
    if (current === 'small') {
      next = 'standard';
    } else if (current === 'standard') {
      next = 'large';
    } else if (current === 'large') {
      next = 'extra_large';
    } else {
      next = 'small';
    }
    this.activeFontScaleMode = next;
    this.applyMarkdownTheme();
    this.fontRevision += 1;
    this.onFontScaleChange(next);
  }

  private applyMarkdownTheme(): void {
    const theme = this.engine.theme.theme;
    theme.document = theme.document ?? {};
    theme.document.font = {
      fontSize: LengthMetrics.fp(this.bodyFontSize()),
      fontColor: this.primaryTextColor()
    };
    theme.document.lineHeight = {
      height: LengthMetrics.fp(this.bodyLineHeight())
    };
    theme.document.blockSpace = LengthMetrics.vp(this.blockSpacing());

    theme.heading = theme.heading ?? {};
    theme.heading.h1 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(28)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Bold
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(36)) }
    };
    theme.heading.h2 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(22)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Bold
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(30)) }
    };
    theme.heading.h3 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(18)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Bold
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(25)) }
    };
    theme.heading.h4 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(16)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Medium
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(23)) }
    };
    theme.heading.h5 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(15)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Medium
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(22)) }
    };
    theme.heading.h6 = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(14)),
        fontColor: this.secondaryTextColor(),
        fontWeight: FontWeight.Medium
      },
      lineHeight: { height: LengthMetrics.fp(this.uiFontSize(21)) }
    };

    theme.thematicBreak = {
      lineHeight: { height: LengthMetrics.vp(this.uiSpacing(32)) },
      lineColor: this.readerBorderColor()
    };
    theme.strong = { font: { fontColor: this.primaryTextColor(), fontWeight: FontWeight.Bold } };
    theme.emphasis = { font: { fontColor: this.primaryTextColor(), fontStyle: FontStyle.Italic } };
    theme.link = { font: { fontColor: this.accentColor() } };
    theme.quote = {
      font: { fontColor: this.secondaryTextColor() },
      edgeWidth: LengthMetrics.vp(3),
      edgeColor: this.accentColor()
    };

    theme.listItem = {
      contentTopBoxWidth: LengthMetrics.vp(this.uiSpacing(24)),
      contentTopBoxFont: {
        fontSize: LengthMetrics.fp(this.uiFontSize(13)),
        fontColor: this.secondaryTextColor()
      },
      contentTopBadgeWidth: LengthMetrics.vp(this.uiSpacing(5)),
      contentTopBadgeBackgroundColor: this.secondaryTextColor(),
      contentBadgeWidth: LengthMetrics.vp(this.uiSpacing(5)),
      contentBadgeBackgroundColor: this.secondaryTextColor(),
      taskFlagWidth: LengthMetrics.vp(this.uiSpacing(18)),
      taskFlagColor: this.accentColor()
    };

    theme.inlineCode = {
      font: {
        fontSize: LengthMetrics.fp(this.uiFontSize(14)),
        fontColor: this.darkMode ? '#DCE8F8' : '#243B53'
      },
      background: {
        color: this.darkMode ? '#18212B' : '#EDF2F7',
        radius: LengthMetrics.vp(5)
      },
      contentPadding: { left: 5, right: 5, top: 2, bottom: 2 }
    };
    theme.table = {
      headerFont: {
        fontSize: LengthMetrics.fp(this.uiFontSize(14)),
        fontColor: this.primaryTextColor(),
        fontWeight: FontWeight.Bold
      },
      headerBackgroundColor: this.darkMode ? '#171C22' : '#F0F2F5',
      contentFont: {
        fontSize: LengthMetrics.fp(this.uiFontSize(14)),
        fontColor: this.primaryTextColor()
      },
      cellMaxWidth: LengthMetrics.vp(240),
      cellMaxWidth4First: LengthMetrics.vp(180),
      cellLineHeight: { height: LengthMetrics.fp(this.uiFontSize(24)) }
    };
    theme.contentBox = {
      barFont: { fontColor: this.secondaryTextColor() },
      barBackgroundColor: this.darkMode ? '#171C22' : '#F0F2F5',
      headerFont: { fontColor: this.secondaryTextColor() },
      headerBackgroundColor: this.darkMode ? '#11151A' : '#F8FAFC',
      border: {
        color: this.readerBorderColor(),
        width: LengthMetrics.vp(1),
        radius: LengthMetrics.vp(12)
      }
    };
  }

  private renderedContent(content: string): string {
    return `${content}\n\n${'\u200B'.repeat(this.fontRevision + 1)}`;
  }

  private scrollToOutlineItem(item: MarkdownOutlineItem): void {
    const estimatedOffset = Math.max(0, item.line * this.bodyFontSize() * 1.45);
    this.scroller.scrollTo({
      xOffset: 0,
      yOffset: estimatedOffset,
      animation: {
        duration: 220,
        curve: Curve.EaseOut
      }
    });
  }

  private bodyFontSize(): number {
    return scaleFontSize(16, this.activeFontScaleMode);
  }

  private bodyLineHeight(): number {
    return scaleFontSize(27, this.activeFontScaleMode);
  }

  private blockSpacing(): number {
    return scaleFontSize(12, this.activeFontScaleMode);
  }

  private uiSpacing(size: number): number {
    return scaleFontSize(size, this.activeFontScaleMode);
  }

  private uiFontSize(size: number): number {
    return scaleFontSize(size, this.activeFontScaleMode);
  }

  private readerMaxWidth(): number {
    return 900;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private canvasColor(): string {
    return this.darkMode ? '#080A0D' : '#F7F8FA';
  }

  private headerColor(): string {
    return this.darkMode ? '#0F1318' : '#FFFFFF';
  }

  private panelColor(): string {
    return this.darkMode ? '#11151A' : '#FFFFFF';
  }

  private surfaceColor(): string {
    return this.darkMode ? '#171C22' : '#F0F2F5';
  }

  private primaryTextColor(): string {
    return this.darkMode ? '#F7F9FC' : '#17202A';
  }

  private secondaryTextColor(): string {
    return this.darkMode ? '#B7C0CB' : '#68717D';
  }

  private readerBorderColor(): string {
    return this.darkMode ? '#2B333D' : '#DDE3EA';
  }

  private accentColor(): string {
    return this.darkMode ? '#68A7FF' : '#1F6FEB';
  }

  private overlayColor(): string {
    return this.darkMode ? '#00000099' : '#00000020';
  }

  private shadowColor(): string {
    return this.darkMode ? '#00000080' : '#1F232824';
  }
}
