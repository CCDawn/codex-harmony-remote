import { fileIo } from '@kit.CoreFileKit';
import {
  IImageServiceRequest,
  IImageServiceResponse,
  ImageServicePlugin
} from 'fluid-markdown';
import { DownloadedRemoteFile } from './ContentActionService';
import { RemoteSessionFile } from '../model/BridgeModels';

export const MAX_MARKDOWN_BYTES: number = 5 * 1024 * 1024;
export const MAX_MERMAID_SOURCE_CHARS: number = 24 * 1024;

export interface MarkdownOutlineItem {
  id: string;
  title: string;
  level: number;
  line: number;
}

export type MarkdownReaderBlockKind = 'markdown' | 'mermaid';

export interface MarkdownReaderBlock {
  id: string;
  kind: MarkdownReaderBlockKind;
  content: string;
  source: string;
  line: number;
}

interface MermaidFence {
  marker: string;
  length: number;
}

export interface MarkdownReaderDocument extends DownloadedRemoteFile {
  content: string;
  safeContent: string;
  blocks: MarkdownReaderBlock[];
  outline: MarkdownOutlineItem[];
  sourceRemotePath: string;
  sourceSessionId: string;
}

/**
 * FluidMarkdown downloads images by default. The app always installs this
 * plug-in as a second safety boundary; document preprocessing also replaces
 * remote image syntax with a visible placeholder before parsing.
 */
export class BlockedMarkdownImageServicePlugin extends ImageServicePlugin {
  static readonly reason: string = 'REMOTE_IMAGE_BLOCKED';

  post: (request: IImageServiceRequest) => Promise<IImageServiceResponse> =
    async (_request: IImageServiceRequest): Promise<IImageServiceResponse> => {
      return {};
    };
}

export class MarkdownDocumentService {
  static isMarkdownFile(file: RemoteSessionFile | DownloadedRemoteFile): boolean {
    const fileName = String(file.fileName ?? '').trim().toLowerCase();
    const mimeType = String(file.mimeType ?? '').trim().toLowerCase();
    return fileName.endsWith('.md')
      || fileName.endsWith('.markdown')
      || mimeType === 'text/markdown'
      || mimeType === 'text/x-markdown';
  }

  static readDownloadedMarkdown(file: DownloadedRemoteFile): MarkdownReaderDocument {
    if (!MarkdownDocumentService.isMarkdownFile(file)) {
      throw new Error('该文件不是 Markdown 文档');
    }
    if (!Number.isFinite(file.bytes) || file.bytes < 0) {
      throw new Error('Markdown 文件大小无效');
    }
    if (file.bytes > MAX_MARKDOWN_BYTES) {
      throw new Error('Markdown 文件超过 5MB 阅读限制，请使用其他应用打开');
    }

    const content = fileIo.readTextSync(file.filePath).replace(/^\uFEFF/, '');
    const safeContent = MarkdownDocumentService.prepareMarkdownForReader(content);
    return {
      fileName: file.fileName,
      filePath: file.filePath,
      uri: file.uri,
      bytes: file.bytes,
      mimeType: file.mimeType,
      openType: file.openType,
      content,
      safeContent,
      blocks: MarkdownDocumentService.splitReaderBlocks(safeContent),
      outline: MarkdownDocumentService.extractOutline(safeContent),
      sourceRemotePath: '',
      sourceSessionId: ''
    };
  }

  static prepareMarkdownForReader(markdown: string): string {
    const normalized = String(markdown ?? '')
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n');
    const withoutRemoteImages = MarkdownDocumentService.replaceRemoteImages(normalized);
    return MarkdownDocumentService.escapeRawHtml(withoutRemoteImages);
  }

  /**
   * FluidMarkdown intentionally renders fenced Mermaid content as a normal
   * code block. Split only a fully closed ```mermaid/~~~mermaid fence so the
   * reader can hand it to the bundled, offline renderer without changing any
   * other Markdown semantics.
   */
  static splitReaderBlocks(markdown: string): MarkdownReaderBlock[] {
    const lines = String(markdown ?? '').split('\n');
    const blocks: MarkdownReaderBlock[] = [];
    let textStart = 0;
    let index = 0;

    while (index < lines.length) {
      const openingFence = MarkdownDocumentService.parseMermaidOpeningFence(lines[index]);
      if (openingFence === null) {
        index += 1;
        continue;
      }

      let closingIndex = index + 1;
      while (closingIndex < lines.length && !MarkdownDocumentService.isClosingFence(
        lines[closingIndex],
        openingFence.marker,
        openingFence.length
      )) {
        closingIndex += 1;
      }

      // An unfinished fence is ordinary Markdown while a document is being
      // edited or was truncated; preserving it is safer than dropping text.
      if (closingIndex >= lines.length) {
        index += 1;
        continue;
      }

      MarkdownDocumentService.appendReaderBlock(
        blocks,
        'markdown',
        lines.slice(textStart, index).join('\n'),
        textStart
      );
      const source = lines.slice(index + 1, closingIndex).join('\n');
      MarkdownDocumentService.appendReaderBlock(blocks, 'mermaid', source, index);
      index = closingIndex + 1;
      textStart = index;
    }

    MarkdownDocumentService.appendReaderBlock(
      blocks,
      'markdown',
      lines.slice(textStart).join('\n'),
      textStart
    );
    if (blocks.length === 0) {
      MarkdownDocumentService.appendReaderBlock(blocks, 'markdown', markdown, 0);
    }
    return blocks;
  }

  static isSupportedMermaidSource(source: string): boolean {
    return MarkdownDocumentService.mermaidSourceError(source).length === 0;
  }

  static mermaidSourceError(source: string): string {
    const normalized = MarkdownDocumentService.normalizeMermaidSource(source);
    if (normalized.length === 0) {
      return 'Mermaid 图表内容为空';
    }
    if (normalized.length > MAX_MERMAID_SOURCE_CHARS) {
      return 'Mermaid 图表超过 24KB 安全渲染限制';
    }
    if (/%%\{|\bclick\b|\bcallback\b|\bhref\b|(?:javascript|data|file|https?):/i.test(normalized)) {
      return '图表包含已禁用的外部链接或交互指令';
    }

    const firstContentLine = normalized.split('\n').find((line: string) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('%%');
    }) ?? '';
    if (!/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i.test(firstContentLine)) {
      return '当前版本仅支持 flowchart / graph 流程图';
    }
    return '';
  }

  static normalizeMermaidSource(source: string): string {
    return String(source ?? '')
      .replace(/\r\n?/g, '\n')
      // Desktop-authored diagrams commonly use the Mermaid-unfriendly literal
      // escape. The renderer accepts <br/> consistently in node labels.
      .replace(/\\n/g, '<br/>')
      .trim();
  }

  private static replaceRemoteImages(markdown: string): string {
    return markdown.replace(
      /!\[[^\]]*\]\(\s*<?https?:\/\/[^)\s>]+(?:\s+["'][^"']*["'])?>?\s*\)/gi,
      '\n> 🖼️ REMOTE_IMAGE_BLOCKED：远程图片已阻止，应用不会自动联网加载。\n'
    );
  }

  private static appendReaderBlock(
    blocks: MarkdownReaderBlock[],
    kind: MarkdownReaderBlockKind,
    content: string,
    line: number
  ): void {
    if (content.length === 0) {
      return;
    }
    blocks.push({
      id: `${kind}-${line}-${blocks.length}`,
      kind,
      content,
      source: content,
      line
    });
  }

  private static parseMermaidOpeningFence(line: string): MermaidFence | null {
    const match = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)\s*$/);
    if (match === null || match[2].toLowerCase() !== 'mermaid') {
      return null;
    }
    return {
      marker: match[1].startsWith('`') ? '`' : '~',
      length: match[1].length
    };
  }

  private static isClosingFence(line: string, marker: string, minLength: number): boolean {
    const trimmed = line.trim();
    if (trimmed.length < minLength) {
      return false;
    }
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] !== marker) {
        return false;
      }
    }
    return true;
  }

  private static escapeRawHtml(markdown: string): string {
    const lines = markdown.split('\n');
    const safeLines: string[] = [];
    let fenceMarker = '';

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence !== null) {
        const marker = fence[1].startsWith('`') ? '`' : '~';
        if (fenceMarker.length === 0) {
          fenceMarker = marker;
        } else if (fenceMarker === marker) {
          fenceMarker = '';
        }
        safeLines.push(line);
        continue;
      }
      safeLines.push(fenceMarker.length > 0 ? line : MarkdownDocumentService.escapeInlineHtml(line));
    }
    return safeLines.join('\n');
  }

  private static escapeInlineHtml(line: string): string {
    let result = '';
    let index = 0;
    while (index < line.length) {
      const character = line[index];
      if (character === '`') {
        let markerEnd = index;
        while (markerEnd < line.length && line[markerEnd] === '`') {
          markerEnd += 1;
        }
        const marker = line.slice(index, markerEnd);
        const closingIndex = line.indexOf(marker, markerEnd);
        if (closingIndex >= 0) {
          result += line.slice(index, closingIndex + marker.length);
          index = closingIndex + marker.length;
          continue;
        }
        result += marker;
        index = markerEnd;
        continue;
      }
      if (character === '<') {
        result += '&lt;';
      } else if (character === '>') {
        result += '&gt;';
      } else {
        result += character;
      }
      index += 1;
    }
    return result;
  }

  private static extractOutline(markdown: string): MarkdownOutlineItem[] {
    const lines = markdown.split('\n');
    const outline: MarkdownOutlineItem[] = [];
    let fenceMarker = '';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence !== null) {
        const marker = fence[1].startsWith('`') ? '`' : '~';
        if (fenceMarker.length === 0) {
          fenceMarker = marker;
        } else if (fenceMarker === marker) {
          fenceMarker = '';
        }
        continue;
      }
      if (fenceMarker.length > 0) {
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading === null) {
        continue;
      }
      const title = MarkdownDocumentService.plainHeadingText(heading[2]);
      if (title.length === 0) {
        continue;
      }
      outline.push({
        id: `heading-${index}`,
        title,
        level: heading[1].length,
        line: index
      });
    }
    return outline;
  }

  private static plainHeadingText(value: string): string {
    const plain = value
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    return plain.length > 120 ? `${plain.slice(0, 117)}...` : plain;
  }
}
