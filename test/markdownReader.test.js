import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const entryPackagePath = path.resolve('HarmonyCodexRemote/entry/oh-package.json5');
const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');
const readerPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/components/MarkdownReader.ets');
const mermaidPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/components/MermaidDiagram.ets');
const mermaidRendererPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/resources/rawfile/mermaid/mermaid_renderer.html'
);
const documentServicePath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/MarkdownDocumentService.ets'
);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('the in-app reader pins the reviewed FluidMarkdown release', () => {
  const packageJson = JSON.parse(read(entryPackagePath));

  assert.equal(packageJson.dependencies?.['fluid-markdown'], '1.0.11');
});

test('the reader uses FluidMarkdown in static normal mode with app-owned controls', () => {
  const reader = read(readerPath);

  assert.match(reader, /from 'fluid-markdown'/);
  assert.match(reader, /BaseEngine/);
  assert.match(reader, /Markdown\(\{/);
  assert.match(reader, /mode:\s*EMarkdownMode\.Normal/);
  assert.match(reader, /目录/);
  assert.match(reader, /字体/);
  assert.match(reader, /复制全文/);
  assert.match(reader, /分享文件/);
  assert.match(reader, /其他应用打开/);
});

test('the reader extracts Mermaid fences into offline, network-blocked diagram cards', () => {
  const reader = read(readerPath);
  const service = read(documentServicePath);
  const diagram = read(mermaidPath);

  assert.match(service, /export interface MarkdownReaderBlock/);
  assert.match(service, /static splitReaderBlocks\(/);
  assert.match(service, /toLowerCase\(\) !== 'mermaid'/);
  assert.match(service, /MAX_MERMAID_SOURCE_CHARS/);
  assert.match(service, /isSupportedMermaidSource/);
  assert.match(reader, /MermaidDiagram/);
  assert.match(reader, /this\.document\.blocks/);
  assert.match(diagram, /\$rawfile\('mermaid\/mermaid_renderer\.html'\)/);
  assert.match(diagram, /\.blockNetwork\(true\)/);
  assert.match(diagram, /\.fileAccess\(false\)/);
  assert.match(diagram, /window\.renderMermaid/);
  assert.match(diagram, /查看源码/);
});

test('the bundled Mermaid renderer is local-only and keeps a strict browser boundary', () => {
  const renderer = read(mermaidRendererPath);

  assert.match(renderer, /<script src="mermaid\.min\.js"><\/script>/);
  assert.match(renderer, /connect-src 'none'/);
  assert.match(renderer, /securityLevel: 'strict'/);
  assert.match(renderer, /当前版本仅支持 flowchart \/ graph 流程图/);
  assert.doesNotMatch(renderer, /<script[^>]+https?:\/\//i);
});

test('the approved reader layout keeps a centered measure and semantic Markdown rhythm', () => {
  const reader = read(readerPath);

  assert.match(reader, /\.constraintSize\(\{\s*maxWidth:\s*this\.readerMaxWidth\(\)\s*\}\)/);
  assert.match(reader, /\.justifyContent\(FlexAlign\.Center\)/);
  assert.match(reader, /private readerMaxWidth\(\): number\s*\{\s*return 900;/);
  assert.match(reader, /theme\.document\.lineHeight\s*=/);
  assert.match(reader, /theme\.document\.blockSpace\s*=/);
  assert.match(reader, /theme\.heading\.h1\s*=/);
  assert.match(reader, /theme\.heading\.h6\s*=/);
  assert.match(reader, /theme\.thematicBreak\s*=/);
  assert.match(reader, /theme\.quote\s*=/);
  assert.match(reader, /theme\.listItem\s*=/);
  assert.match(reader, /theme\.inlineCode\s*=/);
  assert.match(reader, /contentPadding:\s*\{\s*left:\s*5,\s*right:\s*5,\s*top:\s*2,\s*bottom:\s*2\s*\}/);
  assert.match(reader, /theme\.table\s*=/);
  assert.match(reader, /cellMaxWidth:\s*LengthMetrics\.vp\(240\)/);
  assert.match(reader, /cellLineHeight:/);
  assert.doesNotMatch(reader, /engine\.ast\.parse/);
});

test('untrusted Markdown is bounded, escapes raw HTML, and never auto-fetches remote images', () => {
  const service = read(documentServicePath);

  assert.match(service, /MAX_MARKDOWN_BYTES:\s*number\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  assert.match(service, /escapeRawHtml/);
  assert.match(service, /const closingIndex = line\.indexOf\(marker, markerEnd\)/);
  assert.match(service, /REMOTE_IMAGE_BLOCKED/);
  assert.match(service, /ImageServicePlugin/);
  assert.match(service, /post:\s*\(request:\s*IImageServiceRequest\)\s*=>\s*Promise<IImageServiceResponse>/);
  assert.doesNotMatch(service, /@kit\.NetworkKit/);
  assert.doesNotMatch(service, /createHttp|RequestMethod\.GET/);
});

test('downloaded Markdown opens in-app while external open remains available', () => {
  const index = read(indexPath);

  assert.match(index, /MarkdownDocumentService\.isMarkdownFile\(downloaded\)/);
  assert.match(index, /MarkdownDocumentService\.readDownloadedMarkdown\(downloaded\)/);
  assert.match(index, /this\.markdownReaderDocument\s*=\s*document/);
  assert.match(index, /ContentActionService\.openRemoteFile/);
  assert.match(index, /Markdown 阅读器/);
  assert.match(index, /this\.MarkdownReaderOverlay\(\)/);
});

test('system back closes the Markdown reader before navigating away from the conversation', () => {
  const index = read(indexPath);
  const backStart = index.indexOf('onBackPress(): boolean');
  const backEnd = index.indexOf('\n  build()', backStart);
  const backBody = index.slice(backStart, backEnd);

  assert.ok(backStart >= 0 && backEnd > backStart);
  assert.match(backBody, /this\.markdownReaderDocument\s*!==\s*null/);
  assert.match(backBody, /this\.closeMarkdownReader\('system_back'\)/);
  assert.ok(
    backBody.indexOf("this.closeMarkdownReader('system_back')") <
      backBody.indexOf("this.returnToSessionHome('system_back_conversation')"),
    'reader must close before leaving the active conversation'
  );
});
