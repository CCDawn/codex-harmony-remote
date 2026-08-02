import path from 'node:path';

const MOBILE_IMAGE_MARKDOWN = /!\[手机端图片\]\(([^)\r\n]+)\)/giu;

export function extractLocalImageInputs(text) {
  const prompt = String(text ?? '');
  const inputs = [];
  const seen = new Set();
  for (const match of prompt.matchAll(MOBILE_IMAGE_MARKDOWN)) {
    const candidate = normalizeMarkdownPath(match[1]);
    if (!candidate || seen.has(candidate) || !isAbsoluteFilePath(candidate)) {
      continue;
    }
    seen.add(candidate);
    inputs.push({
      type: 'localImage',
      path: candidate
    });
  }
  return inputs;
}

function normalizeMarkdownPath(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isAbsoluteFilePath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}
