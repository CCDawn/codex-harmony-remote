import os from 'node:os';
import path from 'node:path';

export function resolveSafeProjectRoot(project, { action = '创建 Codex 会话' } = {}) {
  const root = String(project?.root ?? '').trim();
  if (!project || root.length === 0) {
    throwWorkspaceError(`${action}缺少有效项目，已阻止启动，避免进入错误工作区。`);
  }

  const resolved = path.resolve(root);
  if (isTemporaryWorkspaceRoot(resolved)) {
    throwWorkspaceError(`${action}的项目目录指向临时目录，已阻止启动：${resolved}`);
  }
  return resolved;
}

export function isTemporaryWorkspaceRoot(value) {
  const candidate = String(value ?? '').trim();
  if (candidate.length === 0) {
    return false;
  }
  const resolved = path.resolve(candidate);
  return temporaryRoots().some((root) => isSameOrChildPath(resolved, root));
}

export function isSameOrChildPath(candidate, root) {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function temporaryRoots() {
  return [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP
  ]
    .filter((value) => String(value ?? '').trim().length > 0)
    .map((value) => path.resolve(String(value)));
}

function normalizeForCompare(value) {
  const resolved = path.resolve(String(value ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function throwWorkspaceError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  throw error;
}
