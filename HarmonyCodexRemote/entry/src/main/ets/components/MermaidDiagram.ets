import { webview } from '@kit.ArkWeb';
import { MarkdownDocumentService } from '../services/MarkdownDocumentService';
import { scaleFontSize } from '../theme/AppTypography';

/**
 * Renders a vetted Mermaid flowchart in a bundled ArkWeb document. Mermaid
 * itself never receives network access and any unsupported or invalid source
 * remains available as an explicit source card instead of a misleading blank.
 */
@ComponentV2
export struct MermaidDiagram {
  @Param @Require source: string;
  @Param darkMode: boolean = true;
  @Param fontScaleMode: string = 'standard';
  @Param landscape: boolean = false;

  @Local sourceVisible: boolean = false;
  @Local rendererReady: boolean = false;
  @Local renderError: string = '';
  @Local renderRevision: number = 0;

  private webController: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    this.renderError = MarkdownDocumentService.mermaidSourceError(this.source);
  }

  @Monitor('source')
  private onSourceChanged(): void {
    this.renderError = MarkdownDocumentService.mermaidSourceError(this.source);
    this.requestRender();
  }

  @Monitor('darkMode')
  private onThemeChanged(): void {
    this.requestRender();
  }

  build() {
    Column({ space: 8 }) {
      this.Header()
      if (this.renderError.length > 0) {
        this.FallbackCard(this.renderError)
      } else {
        Web({
          src: $rawfile('mermaid/mermaid_renderer.html'),
          controller: this.webController
        })
          .width('100%')
          .height(this.diagramHeight())
          .javaScriptAccess(true)
          .domStorageAccess(false)
          .fileAccess(false)
          .blockNetwork(true)
          .backgroundColor(this.surfaceColor())
          .border({ width: 1, color: this.diagramBorderColor() })
          .borderRadius(12)
          .onPageEnd(() => {
            this.rendererReady = true;
            this.requestRender();
          })
      }
      if (this.sourceVisible) {
        this.SourceCard()
      }
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
  }

  @Builder
  private Header() {
    Row({ space: 8 }) {
      Text('Mermaid 流程图')
        .fontSize(this.uiFontSize(12))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.primaryTextColor())
        .layoutWeight(1)
      Button(this.sourceVisible ? '收起源码' : '查看源码')
        .height(30)
        .fontSize(this.uiFontSize(10))
        .fontColor(this.accentColor())
        .backgroundColor(this.surfaceColor())
        .border({ width: 1, color: this.diagramBorderColor() })
        .borderRadius(8)
        .onClick(() => {
          this.sourceVisible = !this.sourceVisible;
        })
    }
    .width('100%')
    .padding({ left: 4, right: 4 })
  }

  @Builder
  private FallbackCard(message: string) {
    Column({ space: 8 }) {
      Text('此 Mermaid 图表暂未渲染')
        .fontSize(this.uiFontSize(12))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.primaryTextColor())
      Text(message)
        .fontSize(this.uiFontSize(10))
        .fontColor(this.secondaryTextColor())
        .lineHeight(this.uiFontSize(16))
      Button(this.sourceVisible ? '收起源码' : '查看源码')
        .height(32)
        .fontSize(this.uiFontSize(10))
        .fontColor(this.accentColor())
        .backgroundColor(this.panelColor())
        .border({ width: 1, color: this.diagramBorderColor() })
        .borderRadius(8)
        .onClick(() => {
          this.sourceVisible = !this.sourceVisible;
        })
    }
    .width('100%')
    .padding(14)
    .backgroundColor(this.surfaceColor())
    .border({ width: 1, color: this.diagramBorderColor() })
    .borderRadius(12)
  }

  @Builder
  private SourceCard() {
    Scroll() {
      Text(this.source)
        .fontSize(this.uiFontSize(10))
        .fontColor(this.darkMode ? '#C8D4E3' : '#273849')
        .fontFamily('monospace')
        .lineHeight(this.uiFontSize(16))
        .width('100%')
        .padding(12)
    }
    .width('100%')
    .height(this.landscape ? 190 : 160)
    .backgroundColor(this.surfaceColor())
    .border({ width: 1, color: this.diagramBorderColor() })
    .borderRadius(10)
    .scrollBar(BarState.Auto)
  }

  private requestRender(): void {
    if (!this.rendererReady || this.renderError.length > 0) {
      return;
    }
    this.renderRevision += 1;
    void this.renderDiagram(this.renderRevision);
  }

  private async renderDiagram(revision: number): Promise<void> {
    const source = MarkdownDocumentService.normalizeMermaidSource(this.source);
    const payload = JSON.stringify({
      source,
      darkMode: this.darkMode,
      revision
    });
    try {
      const result = await this.webController.runJavaScript(
        `window.renderMermaid(${JSON.stringify(payload)})`
      );
      if (revision !== this.renderRevision) {
        return;
      }
      const normalized = String(result ?? '');
      if (!normalized.includes('MERMAID_RENDERED')) {
        this.renderError = this.readRendererError(normalized);
      }
    } catch (_error) {
      if (revision === this.renderRevision) {
        this.renderError = '离线 Mermaid 渲染器暂不可用，请展开源码查看。';
      }
    }
  }

  private readRendererError(result: string): string {
    const marker = 'MERMAID_ERROR:';
    const markerIndex = result.indexOf(marker);
    if (markerIndex < 0) {
      return 'Mermaid 图表语法无法解析，请展开源码查看。';
    }
    const detail = result.slice(markerIndex + marker.length)
      .replace(/^['\"]|['\"]$/g, '')
      .trim();
    return detail.length > 0
      ? `Mermaid 图表语法无法解析：${detail}`
      : 'Mermaid 图表语法无法解析，请展开源码查看。';
  }

  private diagramHeight(): number {
    return this.landscape ? 330 : 286;
  }

  private uiFontSize(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  private surfaceColor(): string {
    return this.darkMode ? '#11151A' : '#FFFFFF';
  }

  private panelColor(): string {
    return this.darkMode ? '#171C22' : '#F0F4F8';
  }

  private primaryTextColor(): string {
    return this.darkMode ? '#F7F9FC' : '#17202A';
  }

  private secondaryTextColor(): string {
    return this.darkMode ? '#B7C0CB' : '#68717D';
  }

  private diagramBorderColor(): string {
    return this.darkMode ? '#2B333D' : '#DDE3EA';
  }

  private accentColor(): string {
    return this.darkMode ? '#68A7FF' : '#1F6FEB';
  }
}
