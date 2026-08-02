import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REMOTE_FILE_MAX_BYTES = 25 * 1024 * 1024;

const REMOTE_FILE_TYPES = new Map([
  ['.txt', ['text/plain', 'general.plain-text']],
  ['.md', ['text/markdown', 'general.plain-text']],
  ['.log', ['text/plain', 'general.plain-text']],
  ['.json', ['application/json', 'general.json']],
  ['.jsonl', ['application/json', 'general.json']],
  ['.yaml', ['application/yaml', 'general.plain-text']],
  ['.yml', ['application/yaml', 'general.plain-text']],
  ['.toml', ['text/plain', 'general.plain-text']],
  ['.xml', ['application/xml', 'general.plain-text']],
  ['.csv', ['text/csv', 'general.comma-separated-values-text']],
  ['.tsv', ['text/tab-separated-values', 'general.tab-separated-values-text']],
  ['.ini', ['text/plain', 'general.plain-text']],
  ['.cfg', ['text/plain', 'general.plain-text']],
  ['.conf', ['text/plain', 'general.plain-text']],
  ['.sql', ['text/plain', 'general.plain-text']],
  ['.html', ['text/html', 'general.html']],
  ['.css', ['text/css', 'general.plain-text']],
  ['.js', ['text/javascript', 'general.source-code']],
  ['.mjs', ['text/javascript', 'general.source-code']],
  ['.cjs', ['text/javascript', 'general.source-code']],
  ['.jsx', ['text/javascript', 'general.source-code']],
  ['.ts', ['text/plain', 'general.source-code']],
  ['.tsx', ['text/plain', 'general.source-code']],
  ['.py', ['text/x-python', 'general.source-code']],
  ['.java', ['text/x-java-source', 'general.source-code']],
  ['.kt', ['text/plain', 'general.source-code']],
  ['.kts', ['text/plain', 'general.source-code']],
  ['.c', ['text/x-c', 'general.source-code']],
  ['.cc', ['text/x-c', 'general.source-code']],
  ['.cpp', ['text/x-c', 'general.source-code']],
  ['.h', ['text/x-c', 'general.source-code']],
  ['.hpp', ['text/x-c', 'general.source-code']],
  ['.cs', ['text/plain', 'general.source-code']],
  ['.go', ['text/plain', 'general.source-code']],
  ['.rs', ['text/plain', 'general.source-code']],
  ['.sh', ['text/x-shellscript', 'general.source-code']],
  ['.ps1', ['text/plain', 'general.source-code']],
  ['.bat', ['text/plain', 'general.source-code']],
  ['.cmd', ['text/plain', 'general.source-code']],
  ['.pdf', ['application/pdf', 'application/pdf']],
  ['.doc', ['application/msword', 'application/msword']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xls', ['application/vnd.ms-excel', 'application/vnd.ms-excel']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.ppt', ['application/vnd.ms-powerpoint', 'application/vnd.ms-powerpoint']],
  ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']],
  ['.png', ['image/png', 'general.png']],
  ['.jpg', ['image/jpeg', 'general.jpeg']],
  ['.jpeg', ['image/jpeg', 'general.jpeg']],
  ['.webp', ['image/webp', 'general.image']],
  ['.gif', ['image/gif', 'general.image']]
]);

export async function prepareRemoteSessionFile({
  threadService,
  sessionId,
  requestedPath,
  maxBytes = DEFAULT_REMOTE_FILE_MAX_BYTES
}) {
  const filePath = normalizeRemoteFilePath(requestedPath);
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  assertPermittedRemoteFileName(fileName, extension);

  if (!threadService || typeof threadService.getThread !== 'function') {
    throw httpError('当前无法读取 Codex 会话。', 503);
  }
  const session = await threadService.getThread(sessionId, { tail: 500 });
  if (!sessionReferencesFile(session, filePath)) {
    throw httpError('该文件没有出现在当前会话中，已阻止下载。', 403);
  }

  const stat = await fs.stat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw httpError('电脑端文件已不存在。', 404);
    }
    throw error;
  });
  if (!stat.isFile()) {
    throw httpError('链接目标不是可下载文件。', 415);
  }
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_REMOTE_FILE_MAX_BYTES);
  if (stat.size <= 0) {
    throw httpError('电脑端文件为空。', 415);
  }
  if (stat.size > limit) {
    throw httpError(`文件超过 ${Math.ceil(limit / (1024 * 1024))}MB 下载限制。`, 413);
  }

  const [mimeType, openType] = REMOTE_FILE_TYPES.get(extension);
  return {
    filePath,
    fileName,
    bytes: stat.size,
    mimeType,
    openType,
    modifiedAt: stat.mtime.toISOString()
  };
}

export function publicRemoteFileMetadata(file) {
  return {
    fileName: file.fileName,
    bytes: file.bytes,
    mimeType: file.mimeType,
    openType: file.openType,
    modifiedAt: file.modifiedAt
  };
}

export function remoteFileContentDisposition(fileName) {
  const asciiName = String(fileName ?? 'download')
    .replace(/[^\x20-\x7E]+/g, '-')
    .replace(/["\\]/g, '-')
    || 'download';
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function normalizeRemoteFilePath(value) {
  let candidate = String(value ?? '').trim();
  if (candidate.startsWith('<') && candidate.endsWith('>')) {
    candidate = candidate.slice(1, -1).trim();
  }
  candidate = candidate.replace(/^["']|["']$/g, '');
  if (candidate.toLowerCase().startsWith('file://')) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:\//.test(candidate)) {
        candidate = candidate.slice(1);
      }
    } catch {
      throw httpError('电脑端文件路径无效。', 400);
    }
  }
  candidate = stripCodexFileLocationSuffix(candidate);
  if (!path.isAbsolute(candidate) || candidate.startsWith('\\\\')) {
    throw httpError('只允许下载电脑端本地绝对路径文件。', 400);
  }
  return path.resolve(candidate);
}

function stripCodexFileLocationSuffix(value) {
  const candidate = String(value ?? '');
  const withoutLocation = candidate.replace(/:\d+(?::\d+)?$/, '');
  if (withoutLocation === candidate) {
    return candidate;
  }
  const extension = path.extname(withoutLocation).toLowerCase();
  return REMOTE_FILE_TYPES.has(extension) ? withoutLocation : candidate;
}

function assertPermittedRemoteFileName(fileName, extension) {
  const lower = String(fileName ?? '').toLowerCase();
  const sensitive = lower === '.env'
    || lower.startsWith('.env.')
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)
    || ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.mobileprovision'].includes(extension)
    || /(^|[._-])(credential|credentials|secrets?|tokens?)([._-]|$)/.test(lower);
  if (!fileName || sensitive || !REMOTE_FILE_TYPES.has(extension)) {
    throw httpError('该文件类型或敏感文件名不允许下载。', 415);
  }
}

function sessionReferencesFile(session, filePath) {
  const expected = normalizeReferenceText(filePath);
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  return entries.some((entry) => {
    if (normalizeReferenceText(entry?.text).includes(expected)) {
      return true;
    }
    const toolItems = Array.isArray(entry?.toolItems) ? entry.toolItems : [];
    return toolItems.some((item) => [
      item?.target,
      item?.detail
    ].some((value) => normalizeReferenceText(value).includes(expected)));
  });
}

function normalizeReferenceText(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/%20/gi, ' ')
    .toLowerCase();
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
