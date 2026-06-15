import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLiveActivityEntry } from './codexLiveActivity.js';
import { normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const MAX_VISIBLE_MESSAGE_LENGTH = 20000;
const ACTIVITY_TAIL_BYTES = 1024 * 1024;
const RECENT_ASSISTANT_PROGRESS_WINDOW_MS = 10 * 60 * 1000;
const TOOL_OUTPUT_SETTLE_WINDOW_MS = 15 * 1000;

export class CodexSessionStore {
  constructor(options = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME;
    this.sessionIndexPath = path.join(this.codexHome, 'session_index.jsonl');
    this.globalStatePath = path.join(this.codexHome, '.codex-global-state.json');
    this.stateDbPath = path.join(this.codexHome, 'state_5.sqlite');
    this.sessionsRoot = path.join(this.codexHome, 'sessions');
    this.mobileImagesDir = options.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images');
  }

  async listSessions({ limit = 50, query = '' } = {}) {
    const desktopSessions = await this.listDesktopSidebarSessions({ limit, query });
    if (desktopSessions.length > 0) {
      return desktopSessions;
    }
    return this.listSessionIndexSessions({ limit, query });
  }

  async listDesktopSidebarSessions({ limit = 50, query = '' } = {}) {
    const [sidebarState, sessionIndex] = await Promise.all([
      readDesktopSidebarState(this.globalStatePath),
      this.readSessionIndexSummaries()
    ]);
    const normalizedQuery = query.trim().toLowerCase();
    const max = clampLimit(limit);
    let rows = [];

    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      rows = db.prepare(`
        SELECT id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event
        FROM threads
        WHERE COALESCE(archived, 0) = 0
          AND COALESCE(thread_source, '') != 'subagent'
          AND COALESCE(source, '') != 'exec'
        ORDER BY COALESCE(updated_at_ms, 0) DESC, COALESCE(updated_at, 0) DESC
        LIMIT 500
      `).all();
      db.close();
    } catch {
      return [];
    }

    const [filePathsById, existingRolloutPaths] = await Promise.all([
      this.listSessionFilePathsById(),
      collectExistingRolloutPathInfo(rows)
    ]);
    const sessions = rows
      .map((row) => {
        const id = String(row.id ?? '');
        const indexSummary = sessionIndex.get(id);
        const rolloutPath = normalizeFilePath(row.rollout_path ?? '');
        const fileInfo = getKnownSessionFileInfo(id, rolloutPath, filePathsById, existingRolloutPaths);
        const title = cleanTitle(indexSummary?.title || row.title || row.first_user_message || row.preview || '未命名会话');
        const projectRoot = normalizeWorkspaceRoot(sidebarState.threadWorkspaceHints[id] ?? row.cwd ?? '');
        const desktopUpdatedAtMs = Number(row.updated_at_ms ?? 0);
        const fileUpdatedAtMs = Number(fileInfo?.updatedAtMs ?? 0);
        const updatedAtMs = fileUpdatedAtMs > 0 ? fileUpdatedAtMs : desktopUpdatedAtMs;
        const activity = summarizeSessionActivity(fileInfo?.path ?? '');
        return {
          id,
          title,
          updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : String(indexSummary?.updatedAt ?? ''),
          updatedAtMs,
          relativeTime: formatRelativeTime(updatedAtMs),
          projectRoot,
          projectLabel: projectRoot.length > 0 ? projectLabelForRoot(projectRoot, sidebarState.workspaceLabels) : '未归类',
          source: 'desktop-sidebar',
          activitySource: fileUpdatedAtMs > 0 ? 'session-file' : 'desktop-sidebar',
          activityStatus: activity.status,
          activityUpdatedAt: activity.updatedAt,
          lastVisibleRole: activity.lastVisibleRole,
          pinned: sidebarState.pinnedThreadIds.has(id),
          hasUserEvent: Number(row.has_user_event ?? 0) === 1,
          detailAvailable: Boolean(fileInfo)
        };
      })
      .filter((session) => session.id.length > 0)
      .filter((session) => session.detailAvailable)
      .filter((session) => isDesktopVisibleSession(session, sidebarState))
      .filter((session) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return `${session.id} ${session.title} ${session.projectLabel} ${session.projectRoot}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        return right.updatedAtMs - left.updatedAtMs;
      })
      .slice(0, max)
      .map(({ updatedAtMs, hasUserEvent, ...session }) => session);

    return sessions;
  }

  async listSessionIndexSessions({ limit = 50, query = '' } = {}) {
    const records = await readJsonl(this.sessionIndexPath);
    const latestById = new Map();
    for (const record of records) {
      if (!record.id) {
        continue;
      }
      const previous = latestById.get(record.id);
      if (!previous || String(record.updated_at ?? '').localeCompare(String(previous.updated_at ?? '')) >= 0) {
        latestById.set(record.id, record);
      }
    }

    const normalizedQuery = query.trim().toLowerCase();
    return [...latestById.values()]
      .filter((record) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return `${record.id ?? ''} ${record.thread_name ?? ''}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')))
      .slice(0, clampLimit(limit))
      .map((record) => ({
        id: String(record.id),
        title: String(record.thread_name ?? '未命名会话'),
        updatedAt: String(record.updated_at ?? ''),
        relativeTime: '',
        projectRoot: '',
        projectLabel: '未归类',
        source: 'session-index',
        pinned: false,
        detailAvailable: true
      }));
  }

  async getSessionReasoningEffort(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
      return '';
    }
    let db = null;
    try {
      db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT reasoning_effort FROM threads WHERE id = ?').get(String(sessionId));
      return normalizeReasoningEffort(row?.reasoning_effort ?? '');
    } catch {
      return '';
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore sqlite close failures during best-effort desktop state reads.
      }
    }
  }

  async getSessionModel(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
      return '';
    }
    let db = null;
    try {
      db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT model FROM threads WHERE id = ?').get(String(sessionId));
      return normalizeModelId(row?.model ?? '');
    } catch {
      return '';
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore sqlite close failures during best-effort desktop state reads.
      }
    }
  }

  async getSession(sessionId, { tail = 80 } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const sessions = await this.listSessions({ limit: 1000 });
    const summary = sessions.find((candidate) => candidate.id === sessionId) ?? {
      id: sessionId,
      title: '未命名会话',
      updatedAt: '',
      detailAvailable: false
    };
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      return {
        ...summary,
        filePath: '',
        detailAvailable: false,
        entries: [{
          timestamp: new Date().toISOString(),
          type: 'missing_session_file',
          role: 'system',
          text: '这个会话仍在 Codex 桌面侧栏数据库中，但本地会话文件已经不存在或已被归档，暂时无法在手机端读取历史内容。'
        }],
        entryCount: 1
      };
    }

    const lines = await readAllLines(filePath);
    const records = parseSessionRecordLines(lines);
    const visibleTail = clampLimit(tail, 200);
    const parsedEntries = parseSessionRecords(records, { mobileImagesDir: this.mobileImagesDir });
    const stat = await fs.stat(filePath).catch(() => null);
    const activity = summarizeActivityRecords(records, {
      fileUpdatedAtMs: Number(stat?.mtimeMs ?? 0)
    });
    const liveActivity = activity.status === 'running'
      ? summarizeLiveActivityFromRecords(records, { threadId: sessionId })
      : null;
    const entries = appendLiveActivityEntry(parsedEntries.slice(-visibleTail), liveActivity);
    return {
      ...summary,
      activityStatus: summary.activityStatus ?? activity.status,
      activityUpdatedAt: summary.activityUpdatedAt ?? activity.updatedAt,
      lastVisibleRole: summary.lastVisibleRole ?? activity.lastVisibleRole,
      detailAvailable: true,
      filePath,
      entries,
      entryCount: entries.length
    };
  }

  async verifySessionTarget(sessionId, fingerprint = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const detail = await this.getSession(sessionId, { tail: 1 });
    if (detail.detailAvailable === false) {
      const error = new Error('目标会话缺少本地历史文件，已阻止发送，避免消息串到其他会话。');
      error.statusCode = 409;
      throw error;
    }

    const expectedFilePath = normalizeFilePath(fingerprint?.filePath ?? '');
    const actualFilePath = normalizeFilePath(detail.filePath ?? '');
    if (expectedFilePath.length > 0 && actualFilePath.length > 0 && expectedFilePath !== actualFilePath) {
      const error = new Error('手机端会话文件指纹已过期，已阻止发送。请重新打开这个会话后再发送。');
      error.statusCode = 409;
      throw error;
    }

    const expectedProjectRoot = normalizeWorkspaceRoot(fingerprint?.projectRoot ?? '');
    const actualProjectRoot = normalizeWorkspaceRoot(detail.projectRoot ?? '');
    if (expectedProjectRoot.length > 0 && actualProjectRoot.length > 0 && expectedProjectRoot !== actualProjectRoot) {
      const error = new Error('手机端会话项目指纹与本地 Codex 记录不一致，已阻止发送。请重新选择会话。');
      error.statusCode = 409;
      throw error;
    }

    return {
      id: detail.id,
      title: detail.title,
      projectRoot: detail.projectRoot ?? '',
      projectLabel: detail.projectLabel ?? '',
      filePath: actualFilePath,
      entryCount: detail.entryCount,
      verifiedAt: new Date().toISOString()
    };
  }

  async getSessionFileCursor(sessionId, filePath = '') {
    const resolvedPath = normalizeFilePath(filePath) || await this.findSessionFile(sessionId);
    if (!resolvedPath) {
      return null;
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return null;
      }
      return {
        sessionId,
        filePath: resolvedPath,
        offset: stat.size,
        updatedAtMs: stat.mtimeMs
      };
    } catch {
      return null;
    }
  }

  async readSessionEntriesAfterCursor(cursor) {
    const records = await this.readSessionRecordsAfterCursor(cursor);
    return parseSessionRecords(records, { mobileImagesDir: this.mobileImagesDir });
  }

  async readSessionRecordsAfterCursor(cursor) {
    if (!cursor?.filePath || !Number.isFinite(Number(cursor.offset))) {
      return [];
    }

    const filePath = normalizeFilePath(cursor.filePath);
    const startOffset = Math.max(0, Number(cursor.offset));
    let handle = null;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size <= startOffset) {
        return [];
      }

      const byteLength = stat.size - startOffset;
      const buffer = Buffer.alloc(byteLength);
      handle = await fs.open(filePath, 'r');
      await handle.read(buffer, 0, byteLength, startOffset);
      const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      return parseSessionRecordLines(lines);
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async findSessionFile(sessionId) {
    const rolloutPath = await this.getThreadRolloutPath(sessionId);
    if (rolloutPath && await fileExists(rolloutPath)) {
      return rolloutPath;
    }

    const files = await collectFiles(this.sessionsRoot);
    const matches = files.filter((file) => path.basename(file).includes(sessionId) && file.endsWith('.jsonl'));
    matches.sort((left, right) => right.localeCompare(left));
    return matches[0] ?? null;
  }

  async getThreadRolloutPath(sessionId) {
    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
      db.close();
      return normalizeFilePath(row?.rollout_path ?? '');
    } catch {
      return '';
    }
  }

  async deleteSession(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const files = await this.findDeletableSessionFiles(sessionId);
    const archivedThreadCount = await this.archiveThreadRecord(sessionId);
    const removedIndexRecords = await this.removeSessionIndexRecords(sessionId);
    const removedGlobalStateEntries = await this.removeThreadFromGlobalState(sessionId);
    const deletedFiles = [];

    for (const filePath of files) {
      await fs.rm(filePath, { force: true });
      deletedFiles.push(filePath);
    }

    if (deletedFiles.length === 0 && archivedThreadCount === 0 && removedIndexRecords === 0 && removedGlobalStateEntries === 0) {
      const error = new Error('未找到可删除的 Codex 会话');
      error.statusCode = 404;
      throw error;
    }

    return {
      id: sessionId,
      deletedFiles,
      archivedThreadCount,
      removedIndexRecords,
      removedGlobalStateEntries,
      deletedAt: new Date().toISOString()
    };
  }

  async findDeletableSessionFiles(sessionId) {
    const candidates = new Set();
    const rolloutPath = await this.getThreadRolloutPath(sessionId);
    if (rolloutPath) {
      candidates.add(rolloutPath);
    }

    const files = await collectFiles(this.sessionsRoot);
    for (const filePath of files) {
      if (filePath.endsWith('.jsonl') && path.basename(filePath).includes(sessionId)) {
        candidates.add(filePath);
      }
    }

    const safeFiles = [];
    for (const filePath of candidates) {
      const resolved = assertDeletableSessionFilePath(filePath, sessionId, this.sessionsRoot);
      if (await fileExists(resolved)) {
        safeFiles.push(resolved);
      }
    }
    return [...new Set(safeFiles)];
  }

  async archiveThreadRecord(sessionId) {
    if (!fsSync.existsSync(this.stateDbPath)) {
      return 0;
    }
    let db = null;
    try {
      db = new DatabaseSync(this.stateDbPath);
      const result = db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(sessionId);
      return Number(result?.changes ?? 0);
    } catch {
      return 0;
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }

  async removeSessionIndexRecords(sessionId) {
    let raw = '';
    try {
      raw = await fs.readFile(this.sessionIndexPath, 'utf8');
    } catch {
      return 0;
    }

    let removed = 0;
    const kept = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (String(record?.id ?? '') === sessionId) {
          removed += 1;
          continue;
        }
      } catch {
      }
      kept.push(line);
    }

    if (removed > 0) {
      await fs.writeFile(this.sessionIndexPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    }
    return removed;
  }

  async removeThreadFromGlobalState(sessionId) {
    let parsed = {};
    try {
      parsed = JSON.parse(await fs.readFile(this.globalStatePath, 'utf8'));
    } catch {
      return 0;
    }

    let removed = 0;
    for (const key of ['pinned-thread-ids', 'projectless-thread-ids']) {
      if (!Array.isArray(parsed[key])) {
        continue;
      }
      const before = parsed[key].length;
      parsed[key] = parsed[key].filter((id) => String(id) !== sessionId);
      removed += before - parsed[key].length;
    }

    if (parsed['thread-workspace-root-hints'] && typeof parsed['thread-workspace-root-hints'] === 'object' && !Array.isArray(parsed['thread-workspace-root-hints'])) {
      if (Object.prototype.hasOwnProperty.call(parsed['thread-workspace-root-hints'], sessionId)) {
        delete parsed['thread-workspace-root-hints'][sessionId];
        removed += 1;
      }
    }

    if (removed > 0) {
      await fs.writeFile(this.globalStatePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    }
    return removed;
  }

  async listSessionFilePathsById() {
    const result = new Map();
    const files = await collectFiles(this.sessionsRoot);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      const match = path.basename(file).match(/([0-9a-f]{4,}-[0-9a-f-]{20,})/i);
      if (match) {
        result.set(match[1], await sessionFileInfo(file));
      }
    }
    return result;
  }

  async readSessionIndexSummaries() {
    const records = await readJsonl(this.sessionIndexPath);
    const latestById = new Map();
    for (const record of records) {
      if (!record.id) {
        continue;
      }
      const previous = latestById.get(record.id);
      if (!previous || String(record.updated_at ?? '').localeCompare(String(previous.updatedAt ?? '')) >= 0) {
        latestById.set(String(record.id), {
          id: String(record.id),
          title: String(record.thread_name ?? ''),
          updatedAt: String(record.updated_at ?? '')
        });
      }
    }
    return latestById;
  }
}

async function readJsonl(filePath) {
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
    }
  }
  return records;
}

async function readDesktopSidebarState(filePath) {
  let parsed = {};
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    parsed = {};
  }
  return {
    workspaceLabels: normalizeKeyedPaths(parsed['electron-workspace-root-labels'] ?? {}),
    threadWorkspaceHints: parsed['thread-workspace-root-hints'] ?? {},
    pinnedThreadIds: new Set(Array.isArray(parsed['pinned-thread-ids']) ? parsed['pinned-thread-ids'].map(String) : []),
    projectlessThreadIds: new Set(Array.isArray(parsed['projectless-thread-ids']) ? parsed['projectless-thread-ids'].map(String) : []),
    visibleWorkspaceRoots: new Set([
      ...normalizePathArray(parsed['electron-saved-workspace-roots'] ?? []),
      ...normalizePathArray(parsed['project-order'] ?? [])
    ])
  };
}

function normalizePathArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeWorkspaceRoot).filter(Boolean);
}

function normalizeKeyedPaths(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized;
  }
  for (const [key, label] of Object.entries(value)) {
    normalized[normalizeWorkspaceRoot(key)] = String(label);
  }
  return normalized;
}

function normalizeWorkspaceRoot(value) {
  return String(value ?? '')
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '');
}

function projectLabelForRoot(projectRoot, workspaceLabels) {
  const normalized = normalizeWorkspaceRoot(projectRoot);
  return workspaceLabels[normalized] ?? path.basename(normalized) ?? normalized;
}

function isDesktopVisibleSession(session, sidebarState) {
  if (session.pinned || sidebarState.projectlessThreadIds.has(session.id)) {
    return true;
  }
  const projectRoot = normalizeWorkspaceRoot(session.projectRoot);
  if (projectRoot.length === 0 || sidebarState.visibleWorkspaceRoots.size === 0) {
    return sidebarState.visibleWorkspaceRoots.size === 0;
  }
  for (const workspaceRoot of sidebarState.visibleWorkspaceRoots) {
    if (isSameOrChildPath(projectRoot, workspaceRoot)) {
      return true;
    }
  }
  return false;
}

function isSameOrChildPath(candidate, parent) {
  const left = normalizeWorkspaceRoot(candidate).toLowerCase();
  const right = normalizeWorkspaceRoot(parent).toLowerCase();
  return left === right || left.startsWith(`${right}${path.sep.toLowerCase()}`);
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 100) {
    return text;
  }
  return `${text.slice(0, 100)}...`;
}

function formatRelativeTime(updatedAtMs) {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return '';
  }
  const diffMs = Date.now() - updatedAtMs;
  if (diffMs < 60 * 1000) {
    return '刚刚';
  }
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }
  return new Date(updatedAtMs).toLocaleDateString('zh-CN');
}

async function collectFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let items = [];
    try {
      items = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(fullPath);
      } else if (item.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function collectExistingRolloutPathInfo(rows) {
  const paths = [...new Set(rows.map((row) => normalizeFilePath(row.rollout_path ?? '')).filter(Boolean))];
  const existing = new Map();
  await Promise.all(paths.map(async (filePath) => {
    const info = await sessionFileInfo(filePath);
    if (info) {
      existing.set(filePath, info);
    }
  }));
  return existing;
}

function getKnownSessionFileInfo(sessionId, rolloutPath, filePathsById, existingRolloutPaths) {
  if (rolloutPath.length > 0) {
    return existingRolloutPaths.get(rolloutPath) ?? null;
  }
  return filePathsById.get(sessionId) ?? null;
}

async function sessionFileInfo(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      path: filePath,
      updatedAtMs: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

function summarizeSessionActivity(filePath) {
  if (!filePath) {
    return {
      status: 'idle',
      updatedAt: '',
      lastVisibleRole: ''
    };
  }
  try {
    const stat = fsSync.statSync(filePath);
    const raw = readFileTail(filePath, ACTIVITY_TAIL_BYTES);
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return summarizeActivityRecords(parseSessionRecordLines(lines), {
      fileUpdatedAtMs: stat.mtimeMs
    });
  } catch {
    return {
      status: 'idle',
      updatedAt: '',
      lastVisibleRole: ''
    };
  }
}

function summarizeActivityRecords(records, options = {}) {
  let lastTaskStartedAt = '';
  let lastTaskCompleteAt = '';
  let lastTurnAbortedAt = '';
  let lastUserAt = '';
  let lastAssistantProgressAt = '';
  let lastAssistantFinalAt = '';
  let lastWorkStartedAt = '';
  let lastToolOutputAt = '';
  let lastVisibleAt = '';
  let lastVisibleRole = '';
  for (const record of records) {
    const timestamp = String(record.timestamp ?? '');
    const type = String(record.type ?? '');
    const payload = record.payload ?? {};
    if (isTurnAbortedRecord(record)) {
      lastTurnAbortedAt = latestTimestamp(lastTurnAbortedAt, timestamp);
      continue;
    }
    if (type === 'event_msg' && payload.type === 'task_started') {
      lastTaskStartedAt = timestamp;
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
      continue;
    }
    if (type === 'event_msg' && payload.type === 'task_complete') {
      lastTaskCompleteAt = timestamp;
      continue;
    }
    if (type === 'response_item' && payload.type === 'function_call') {
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
    } else if (type === 'response_item' && payload.type === 'reasoning') {
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
    } else if (type === 'response_item' && payload.type === 'function_call_output') {
      lastToolOutputAt = latestTimestamp(lastToolOutputAt, timestamp);
    }
    const entry = summarizeRecord(record);
    if (entry) {
      lastVisibleAt = entry.timestamp;
      lastVisibleRole = entry.role;
      if (entry.role === 'user') {
        lastUserAt = entry.timestamp;
        lastAssistantProgressAt = '';
        lastAssistantFinalAt = '';
      } else if (entry.role === 'assistant') {
        if (String(payload.phase ?? '') === 'final_answer') {
          lastAssistantFinalAt = entry.timestamp;
        } else if (String(payload.phase ?? '') === 'commentary' || type === 'event_msg') {
          lastAssistantProgressAt = entry.timestamp;
          lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, entry.timestamp);
        }
      }
    }
  }
  const lastTerminalAt = latestTimestamp(lastTaskCompleteAt, lastAssistantFinalAt, lastTurnAbortedAt);
  const taskIsOpen = lastTaskStartedAt && (!lastTerminalAt || lastTaskStartedAt > lastTerminalAt);
  if (taskIsOpen) {
    const lastOpenActivityAt = latestTimestamp(lastWorkStartedAt, lastAssistantProgressAt, lastVisibleAt);
    const outputIsLatestOpenActivity = lastToolOutputAt
      && lastToolOutputAt >= lastOpenActivityAt
      && (!lastTerminalAt || lastToolOutputAt > lastTerminalAt);
    if (outputIsLatestOpenActivity && !isRecentToolOutputSettling(lastToolOutputAt, options)) {
      if (lastAssistantProgressAt && (!lastUserAt || lastAssistantProgressAt > lastUserAt)) {
        return {
          status: 'completed',
          updatedAt: lastToolOutputAt,
          lastVisibleRole
        };
      }
      return {
        status: 'idle',
        updatedAt: lastToolOutputAt,
        lastVisibleRole
      };
    }
    const taskActivityAt = outputIsLatestOpenActivity
      ? lastToolOutputAt
      : latestTimestamp(lastTaskStartedAt, lastAssistantProgressAt, lastWorkStartedAt);
    if (isRecentAssistantProgress(taskActivityAt, options)) {
      return {
        status: 'running',
        updatedAt: taskActivityAt,
        lastVisibleRole
      };
    }
  }
  if (
    lastUserAt &&
    (!lastTaskCompleteAt || lastUserAt > lastTaskCompleteAt) &&
    lastAssistantProgressAt &&
    !lastAssistantFinalAt &&
    isRecentAssistantProgress(lastAssistantProgressAt, options)
  ) {
    return {
      status: 'running',
      updatedAt: lastAssistantProgressAt,
      lastVisibleRole
    };
  }
  if (!lastUserAt && lastAssistantProgressAt && (!lastTerminalAt || lastAssistantProgressAt > lastTerminalAt) && isRecentAssistantProgress(lastAssistantProgressAt, options)) {
    return {
      status: 'running',
      updatedAt: lastAssistantProgressAt,
      lastVisibleRole
    };
  }
  if (lastTerminalAt) {
    return {
      status: 'completed',
      updatedAt: lastTerminalAt,
      lastVisibleRole
    };
  }
  return {
    status: 'idle',
    updatedAt: lastVisibleAt,
    lastVisibleRole
  };
}

function isRecentToolOutputSettling(timestamp, options = {}) {
  const outputMs = Date.parse(timestamp || '');
  if (!Number.isFinite(outputMs)) {
    return false;
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return nowMs - outputMs >= 0 && nowMs - outputMs <= TOOL_OUTPUT_SETTLE_WINDOW_MS;
}

function isRecentAssistantProgress(timestamp, options = {}) {
  const progressMs = Date.parse(timestamp || '');
  if (!Number.isFinite(progressMs)) {
    return false;
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const fileUpdatedAtMs = Number(options.fileUpdatedAtMs ?? 0);
  const freshByRecordTime = nowMs - progressMs >= 0 && nowMs - progressMs <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS;
  const freshByFileTime = fileUpdatedAtMs > 0 && Math.abs(fileUpdatedAtMs - progressMs) <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS && nowMs - fileUpdatedAtMs <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS;
  return freshByRecordTime || freshByFileTime;
}

function latestTimestamp(...values) {
  let latest = '';
  for (const value of values) {
    if (!value) {
      continue;
    }
    const timestamp = String(value);
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

function readFileTail(filePath, maxBytes) {
  const fd = fsSync.openSync(filePath, 'r');
  try {
    const stat = fsSync.fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    fsSync.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    fsSync.closeSync(fd);
  }
}

function normalizeFilePath(value) {
  return String(value ?? '')
    .replace(/^\\\\\?\\/, '')
    .trim();
}

function assertDeletableSessionFilePath(filePath, sessionId, sessionsRoot) {
  const resolvedRoot = path.resolve(sessionsRoot);
  const resolvedPath = path.resolve(normalizeFilePath(filePath));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('拒绝删除 Codex 会话目录之外的文件');
    error.statusCode = 403;
    throw error;
  }
  if (path.extname(resolvedPath).toLowerCase() !== '.jsonl' || !path.basename(resolvedPath).includes(sessionId)) {
    const error = new Error('拒绝删除无法确认归属的会话文件');
    error.statusCode = 403;
    throw error;
  }
  return resolvedPath;
}

async function readAllLines(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseSessionLines(lines, options = {}) {
  return parseSessionRecords(parseSessionRecordLines(lines), options);
}

function parseSessionRecordLines(lines) {
  const records = [];
  for (const line of lines) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    records.push(record);
  }
  return records;
}

function parseSessionRecords(records, options = {}) {
  const entries = [];
  for (const record of records) {
    const summarized = summarizeRecord(record, options);
    const recordEntries = Array.isArray(summarized) ? summarized : [summarized];
    for (const entry of recordEntries) {
      if (!entry) {
        continue;
      }
      entries.push(entry);
    }
  }
  return compactToolStatusRuns(dedupeAdjacentMessages(entries));
}

function appendLiveActivityEntry(entries, liveActivity) {
  const stableEntries = entries.filter((entry) => entry.type !== 'live_activity');
  if (!liveActivity) {
    return stableEntries;
  }
  return [...stableEntries, liveActivity];
}

function summarizeLiveActivityFromRecords(records, options = {}) {
  let latest = null;
  for (const record of records) {
    const entry = summarizeLiveActivityRecord(record, options);
    if (entry) {
      latest = entry;
    }
  }
  if (latest) {
    return latest;
  }
  return createLiveActivityEntry({
    timestamp: new Date().toISOString(),
    kind: 'status',
    text: 'Codex 正在处理当前消息',
    threadId: options.threadId ?? ''
  });
}

function summarizeLiveActivityRecord(record, options = {}) {
  const timestamp = String(record.timestamp ?? '') || new Date().toISOString();
  const type = String(record.type ?? '');
  const payload = record.payload ?? {};

  if (type === 'event_msg' && payload.type === 'agent_message') {
    const text = sanitizeVisibleSessionText(extractTextElements(payload));
    if (text.length > 0) {
      return createLiveActivityEntry({
        timestamp,
        kind: 'assistant',
        role: 'assistant',
        text,
        threadId: options.threadId ?? '',
        turnId: String(payload.turn_id ?? payload.turnId ?? ''),
        itemId: String(payload.id ?? '')
      });
    }
  }

  if (type !== 'response_item') {
    return null;
  }

  if (payload.type === 'reasoning') {
    return createLiveActivityEntry({
      timestamp,
      kind: 'reasoning',
      text: extractReasoningSummary(payload),
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.id ?? '')
    });
  }

  if (payload.type === 'function_call') {
    const summary = summarizeFunctionCall(payload);
    if (summary.length === 0) {
      return null;
    }
    const kind = summary.startsWith('正在执行') ? 'command' : 'tool';
    return createLiveActivityEntry({
      timestamp,
      kind,
      text: stripActivityVerb(summary, kind),
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.call_id ?? payload.id ?? '')
    });
  }

  if (payload.type === 'function_call_output') {
    const output = typeof payload.output === 'string' ? summarizeToolOutput(payload.output) : '';
    const summary = output || summarizeFunctionCallOutput(payload);
    return createLiveActivityEntry({
      timestamp,
      kind: 'command',
      text: summary,
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.call_id ?? payload.id ?? '')
    });
  }

  if (payload.type === 'message' && payload.role === 'assistant' && payload.phase !== 'final_answer') {
    const text = sanitizeVisibleSessionText(extractMessageContent(payload.content, options));
    if (text.length > 0) {
      return createLiveActivityEntry({
        timestamp,
        kind: 'assistant',
        role: 'assistant',
        text,
        threadId: options.threadId ?? '',
        turnId: String(payload.turn_id ?? payload.turnId ?? ''),
        itemId: String(payload.id ?? '')
      });
    }
  }

  return null;
}

function stripActivityVerb(summary, kind) {
  const text = String(summary ?? '').trim();
  if (kind === 'command') {
    return text.replace(/^正在执行\s*/, '').replace(/^命令[:：]\s*/, '');
  }
  if (kind === 'tool') {
    return text.replace(/^正在调用\s*/, '');
  }
  return text;
}

function dedupeAdjacentMessages(entries) {
  const deduped = [];
  for (const entry of entries) {
    const previous = deduped.at(-1);
    if (previous && isDuplicateVisibleMessage(previous, entry)) {
      const merged = mergeVisibleMessages(previous, entry);
      previous.timestamp = merged.timestamp;
      previous.type = merged.type;
      previous.text = merged.text;
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function compactToolStatusRuns(entries) {
  const compacted = [];
  let toolRun = [];
  const flushToolRun = () => {
    if (toolRun.length === 0) {
      return;
    }
    const summarized = summarizeToolRun(toolRun);
    if (summarized) {
      compacted.push(summarized);
    }
    toolRun = [];
  };

  for (const entry of entries) {
    if (entry.role === 'tool' && (entry.type === 'tool_call' || entry.type === 'tool_result')) {
      toolRun.push(entry);
      continue;
    }
    flushToolRun();
    compacted.push(entry);
  }
  flushToolRun();
  return compacted;
}

function summarizeToolRun(entries) {
  if (entries.length === 0) {
    return null;
  }
  const last = entries.at(-1);
  const completedCount = entries.filter(isCompletedToolResultEntry).reduce((sum, entry) => {
    const match = firstLine(entry.text).match(/^已运行\s+(\d+)\s+条命令$/);
    return sum + Number.parseInt(match?.[1] ?? '0', 10);
  }, 0);
  if (completedCount > 0) {
    const details = summarizeToolRunDetails(entries);
    const summary = `已运行 ${completedCount} 条命令`;
    return {
      timestamp: last.timestamp,
      type: 'tool_result',
      role: 'tool',
      text: details.length > 0 ? `${summary}\n\n${details}` : summary
    };
  }
  return last;
}

function isCompletedToolResultEntry(entry) {
  return entry.role === 'tool'
    && entry.type === 'tool_result'
    && /^已运行\s+\d+\s+条命令$/.test(firstLine(entry.text));
}

function summarizeToolRunDetails(entries) {
  const details = [];
  let pendingCommand = '';
  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      pendingCommand = commandFromToolCallText(entry.text);
      continue;
    }
    if (!isCompletedToolResultEntry(entry)) {
      continue;
    }
    const resultText = toolResultDetailText(entry.text);
    const title = pendingCommand.length > 0 ? pendingCommand : '命令';
    const output = resultText.length > 0 ? `\n输出：${resultText}` : '';
    details.push(`${details.length + 1}. ${title}${output}`);
    pendingCommand = '';
  }
  if (details.length === 0) {
    return '';
  }
  const visibleDetails = details.slice(0, 20);
  const hiddenCount = details.length - visibleDetails.length;
  if (hiddenCount > 0) {
    visibleDetails.push(`还有 ${hiddenCount} 条命令未展开显示`);
  }
  return visibleDetails.join('\n');
}

function commandFromToolCallText(text) {
  const value = String(text ?? '').trim();
  const commandPrefix = '正在执行 ';
  if (value.startsWith(commandPrefix)) {
    return value.slice(commandPrefix.length).trim();
  }
  return value;
}

function toolResultDetailText(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(1).join('\n').trim();
  return truncateInline(lines, 500);
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/, 1)[0].trim();
}

function isDuplicateVisibleMessage(left, right) {
  if (left.role !== right.role) {
    return false;
  }
  const leftText = normalizeMessageForDedupe(left.text);
  const rightText = normalizeMessageForDedupe(right.text);
  if (leftText.length === 0 || rightText.length === 0) {
    return false;
  }
  if (leftText === rightText) {
    return true;
  }
  if (left.timestamp && right.timestamp && left.timestamp === right.timestamp) {
    return leftText.includes(rightText) || rightText.includes(leftText);
  }
  return false;
}

function mergeVisibleMessages(left, right) {
  const richer = String(right.text ?? '').length > String(left.text ?? '').length ? right : left;
  return {
    timestamp: right.timestamp || left.timestamp,
    type: richer.type || right.type || left.type,
    text: richer.text
  };
}

function normalizeMessageForDedupe(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function summarizeRecord(record, options = {}) {
  const timestamp = String(record.timestamp ?? '');
  const type = String(record.type ?? 'unknown');
  const payload = record.payload ?? {};

  if (type === 'event_msg' && payload.type === 'user_message') {
    const text = extractTextElements(payload);
    if (isInternalSessionText(text)) {
      return null;
    }
    const visibleText = sanitizeVisibleSessionText(text, { stripLeadingSkillToken: true });
    if (visibleText.length === 0) {
      return null;
    }
    return {
      timestamp,
      type,
      role: 'user',
      text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
    };
  }

  if (type === 'event_msg' && payload.type === 'agent_message') {
    const text = extractTextElements(payload);
    if (isInternalSessionText(text)) {
      return null;
    }
    const visibleText = sanitizeVisibleSessionText(text);
    if (visibleText.length === 0) {
      return null;
    }
    return {
      timestamp,
      type,
      role: 'assistant',
      text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
    };
  }

  if (type === 'response_item') {
    const itemType = payload.type;
    if (itemType === 'message') {
      const text = extractMessageContent(payload.content, options);
      if (isInternalSessionText(text)) {
        return null;
      }
      const role = payload.role ?? 'assistant';
      const visibleText = sanitizeVisibleSessionText(text, { stripLeadingSkillToken: role === 'user' });
      if (visibleText.length === 0) {
        return null;
      }
      return {
        timestamp,
        type,
        role,
        text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
      };
    }
    if (itemType === 'function_call') {
      const summary = summarizeFunctionCall(payload);
      return summary ? {
        timestamp,
        type: 'tool_call',
        role: 'tool',
        text: summary
      } : null;
    }
    if (itemType === 'function_call_output') {
      const summary = summarizeFunctionCallOutput(payload, { ...options, includeImageMarkdown: true });
      return summary ? {
        timestamp,
        type: 'tool_result',
        role: 'tool',
        text: summary
      } : null;
    }
    if (itemType === 'reasoning') {
      const summary = extractReasoningSummary(payload);
      return {
        timestamp,
        type: 'reasoning',
        role: 'system',
        text: summary || '正在思考'
      };
    }
  }

  return null;
}

function isTurnAbortedRecord(record) {
  const type = String(record.type ?? '');
  const payload = record.payload ?? {};
  if (type === 'event_msg' && payload.type === 'user_message') {
    return isTurnAbortedText(extractTextElements(payload));
  }
  if (type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    return isTurnAbortedText(extractMessageContent(payload.content));
  }
  return false;
}

function isTurnAbortedText(value) {
  return String(value ?? '').trim().startsWith('<turn_aborted>');
}

function extractTextElements(payload) {
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  if (Array.isArray(payload.text_elements)) {
    return payload.text_elements.map((item) => String(item.text ?? item)).join('\n');
  }
  return '';
}

function extractMessageContent(content, options = {}) {
  if (typeof content === 'string') {
    return materializeMarkdownImagesForMobile(content, options.mobileImagesDir);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const imageMarkdown = [];
  const text = content.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    if (isImageContentItem(item)) {
      const markdown = materializeImageItemForMobile(item, options.mobileImagesDir);
      if (markdown.length > 0) {
        imageMarkdown.push(markdown);
      }
      return '';
    }
    return String(item.text ?? item.content ?? '');
  }).filter(Boolean).join('\n');
  return [materializeMarkdownImagesForMobile(text, options.mobileImagesDir), ...imageMarkdown].filter(Boolean).join('\n');
}

function isImageContentItem(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const type = String(item.type ?? '').toLowerCase();
  return type === 'input_image'
    || type === 'output_image'
    || Object.hasOwn(item, 'image_url')
    || Object.hasOwn(item, 'imageUrl');
}

function materializeImageItemForMobile(item, mobileImagesDir = '') {
  if (!item || typeof item !== 'object') {
    return '';
  }
  const imageUrl = item.image_url ?? item.imageUrl ?? item.url ?? item.data;
  if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
    return materializeImageDataUrlForMobile(imageUrl, mobileImagesDir);
  }
  const base64 = String(item.base64 ?? '').trim();
  if (base64.length > 0) {
    const mimeType = String(item.mimeType ?? item.mime_type ?? 'image/png').trim() || 'image/png';
    return materializeImageDataUrlForMobile(`data:${mimeType};base64,${base64}`, mobileImagesDir);
  }
  return '';
}

function materializeImageDataUrlForMobile(imageUrl, mobileImagesDir = '') {
  const parsed = parseImageDataUrl(imageUrl);
  if (!parsed) {
    return '';
  }
  const bytes = Buffer.from(parsed.base64, 'base64');
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
    return '';
  }
  const uploadDir = path.resolve(mobileImagesDir || path.join(process.cwd(), 'logs', 'mobile-images'));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const filePath = path.join(uploadDir, `desktop-${hash}.${parsed.extension}`);
  try {
    fsSync.mkdirSync(uploadDir, { recursive: true });
    if (!fsSync.existsSync(filePath)) {
      fsSync.writeFileSync(filePath, bytes);
    }
    return `![桌面端图片](${filePath.replace(/\\/g, '/')})`;
  } catch {
    return '';
  }
}

function materializeLocalImageForMobile(imagePath, mobileImagesDir = '') {
  const filePath = normalizeLocalImagePath(imagePath);
  if (filePath.length === 0 || !isSupportedImageFilePath(filePath)) {
    return '';
  }
  try {
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) {
      return '';
    }
    const uploadDir = path.resolve(mobileImagesDir || path.join(process.cwd(), 'logs', 'mobile-images'));
    const resolvedFilePath = path.resolve(filePath);
    if (isPathInside(resolvedFilePath, uploadDir)) {
      return resolvedFilePath.replace(/\\/g, '/');
    }
    const bytes = fsSync.readFileSync(resolvedFilePath);
    const extension = path.extname(resolvedFilePath).slice(1).toLowerCase() || 'png';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const copiedPath = path.join(uploadDir, `desktop-${hash}.${extension}`);
    fsSync.mkdirSync(uploadDir, { recursive: true });
    if (!fsSync.existsSync(copiedPath)) {
      fsSync.writeFileSync(copiedPath, bytes);
    }
    return copiedPath.replace(/\\/g, '/');
  } catch {
    return '';
  }
}

function materializeMarkdownImagesForMobile(text, mobileImagesDir = '') {
  return String(text ?? '').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, label, target) => {
    const trimmedTarget = String(target ?? '').trim();
    const dataMarkdown = materializeImageDataUrlForMobile(trimmedTarget, mobileImagesDir);
    if (dataMarkdown.length > 0) {
      const dataPath = dataMarkdown.match(/\((.+)\)$/)?.[1] ?? '';
      return dataPath.length > 0 ? `![${label || '桌面端图片'}](${dataPath})` : match;
    }
    if (/^https?:\/\//i.test(trimmedTarget)) {
      return match;
    }
    const copiedPath = materializeLocalImageForMobile(trimmedTarget, mobileImagesDir);
    if (copiedPath.length === 0) {
      return match;
    }
    return `![${label || '桌面端图片'}](${copiedPath})`;
  });
}

function normalizeLocalImagePath(value) {
  const trimmed = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0 || /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return '';
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  return trimmed.replace(/\//g, path.sep);
}

function isSupportedImageFilePath(value) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(value ?? '').trim());
}

function isPathInside(filePath, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseImageDataUrl(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  return {
    extension: imageExtensionForMime(match[1]),
    base64: match[2].replace(/\s+/g, '')
  };
}

function imageExtensionForMime(mimeType) {
  const normalized = String(mimeType ?? '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'jpg';
  }
  if (normalized === 'image/webp') {
    return 'webp';
  }
  if (normalized === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

function summarizeFunctionCall(payload) {
  const name = String(payload.name ?? '').trim();
  if (name === 'exec_command' || name === 'shell_command' || name === 'command') {
    const command = commandFromFunctionArguments(payload.arguments);
    return command ? `正在执行 ${command}` : '正在执行命令';
  }
  if (name === 'view_image') {
    return '正在查看图片';
  }
  if (name.length > 0) {
    return `正在调用 ${name}`;
  }
  return '正在调用工具';
}

function summarizeFunctionCallOutput(payload, options = {}) {
  if (Array.isArray(payload.output)) {
    const imageMarkdown = options.includeImageMarkdown === true
      ? payload.output.map((item) => materializeImageItemForMobile(item, options.mobileImagesDir)).filter(Boolean)
      : [];
    if (payload.output.some((item) => item?.type === 'input_image')) {
      return ['已查看图片', ...imageMarkdown].filter(Boolean).join('\n');
    }
    if (imageMarkdown.length > 0) {
      return ['已生成图片', ...imageMarkdown].join('\n');
    }
  }
  const output = typeof payload.output === 'string' ? payload.output : '';
  const commandCount = countToolCommands(output);
  if (commandCount > 0) {
    const summary = summarizeToolOutput(output);
    return summary.length > 0 ? `已运行 ${commandCount} 条命令\n${summary}` : `已运行 ${commandCount} 条命令`;
  }
  return '工具调用完成';
}

function commandFromFunctionArguments(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    const command = String(parsed.cmd ?? parsed.command ?? '').trim();
    return truncateInline(command, 110);
  } catch {
    return '';
  }
}

function countToolCommands(output) {
  const text = String(output ?? '');
  if (/Process exited with code|Wall time:|Chunk ID:|Exit code:/i.test(text)) {
    return 1;
  }
  return 0;
}

function summarizeToolOutput(output) {
  const text = String(output ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    return '';
  }
  const lines = text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Original token count:/i.test(line));
  const important = [];
  for (const line of lines) {
    if (/^(Exit code:|Process exited with code|Wall time:|Chunk ID:)/i.test(line)) {
      important.push(line);
    }
  }
  if (important.length > 0) {
    return truncateInline(important.join('；'), 500);
  }
  return truncateInline(lines.slice(0, 3).join('；'), 500);
}

function extractReasoningSummary(payload) {
  const text = String(payload.text ?? payload.summaryText ?? payload.summary ?? '').trim();
  return text.length > 0 ? truncateInline(text, 120) : '';
}

function truncateInline(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function clampLimit(value, max = 100) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(parsed, 1), max);
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function isInternalSessionText(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) {
    return false;
  }
  return isTurnAbortedText(text)
    || text.startsWith('<permissions instructions>')
    || text.startsWith('<environment_context>')
    || text.startsWith('<app-context>')
    || text.startsWith('<collaboration_mode>')
    || text.startsWith('<skills_instructions>')
    || text.startsWith('<plugins_instructions>')
    || text.startsWith('# AGENTS.md instructions');
}

function sanitizeVisibleSessionText(value, options = {}) {
  let text = String(value ?? '');
  text = stripInternalInstructionBlocks(text);
  text = stripImagePlaceholderBlocks(text);
  text = stripCodexDirectiveBlocks(text);
  if (options.stripLeadingSkillToken === true) {
    text = stripLeadingSkillToken(text);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function stripImagePlaceholderBlocks(value) {
  return String(value ?? '')
    .replace(/<image(?:\s+[^>]*)?>\s*<\/image>/gi, '')
    .replace(/^\s*<image(?:\s+[^>]*)?>\s*$/gim, '')
    .replace(/^\s*<\/image>\s*$/gim, '');
}

function stripInternalInstructionBlocks(value) {
  let text = String(value ?? '');
  const blockNames = [
    'permissions instructions',
    'environment_context',
    'app-context',
    'collaboration_mode',
    'skills_instructions',
    'plugins_instructions',
    'turn_aborted',
    'personality_spec'
  ];
  for (const name of blockNames) {
    text = stripXmlLikeBlock(text, name);
  }
  const agentsIndex = text.indexOf('# AGENTS.md instructions');
  if (agentsIndex >= 0) {
    text = text.slice(0, agentsIndex);
  }
  return text;
}

function stripCodexDirectiveBlocks(value) {
  const lines = String(value ?? '').split('\n');
  const kept = [];
  let skippingDirective = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippingDirective && isCodexDirectiveStart(trimmed)) {
      skippingDirective = !isCodexDirectiveEnd(trimmed);
      continue;
    }
    if (skippingDirective) {
      if (isCodexDirectiveEnd(trimmed)) {
        skippingDirective = false;
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function isCodexDirectiveStart(trimmedLine) {
  return trimmedLine.startsWith('::code-comment{')
    || trimmedLine.startsWith('::archive{');
}

function isCodexDirectiveEnd(trimmedLine) {
  return trimmedLine.endsWith('}');
}

function stripXmlLikeBlock(value, blockName) {
  let text = String(value ?? '');
  const open = `<${blockName}>`;
  const close = `</${blockName}>`;
  let guard = 0;
  while (guard < 12) {
    const start = text.indexOf(open);
    if (start < 0) {
      break;
    }
    const end = text.indexOf(close, start + open.length);
    if (end < 0) {
      text = text.slice(0, start);
      break;
    }
    text = `${text.slice(0, start)}${text.slice(end + close.length)}`;
    guard += 1;
  }
  return text;
}

function stripLeadingSkillToken(value) {
  return String(value ?? '').replace(/^\s*\$[A-Za-z0-9][A-Za-z0-9_.-]*(?:\s+|$)/, '');
}
