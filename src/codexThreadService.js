import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { buildSessionSnapshot, sanitize, summarizeThreadForEvent } from './codexProtocolUtils.js';
import { CodexAppServerEventConverter } from './codexAppServerEvents.js';
import { isLiveActivityEntry } from './codexLiveActivity.js';
import { classifyCodexClientNotice, createCodexClientNoticeEntry } from './codexClientNotices.js';
import { normalizeModelId } from './sessionSettingsStore.js';
import { isSameOrChildPath, resolveSafeProjectRoot } from './workspaceGuard.js';

const VALID_THREAD_ID = /^[A-Za-z0-9_-]+$/;
const MAX_RUNNING_DESKTOP_REFRESHES = 6;

export class CodexThreadService {
  constructor(options = {}) {
    this.client = options.client ?? new CodexAppServerClient(options);
    this.sessions = options.sessions ?? null;
    this.projects = options.projects ?? [];
    this.eventBus = options.eventBus ?? null;
    this.logger = options.logger ?? null;
    this.desktopOpener = options.desktopOpener ?? null;
    this.autoOpenDesktop = options.autoOpenDesktop ?? process.env.CODEX_BRIDGE_AUTO_OPEN_DESKTOP === '1';
    this.model = options.model ?? process.env.CODEX_BRIDGE_MODEL ?? '';
    this.sandbox = options.sandbox ?? process.env.CODEX_BRIDGE_SANDBOX ?? 'danger-full-access';
    this.approvalPolicy = options.approvalPolicy ?? process.env.CODEX_BRIDGE_APPROVAL_POLICY ?? 'never';
    this.runs = new Map();
    this.liveSessions = new Map();
    this.activeRunsByTurnId = new Map();
    this.activeRunsByThreadId = new Map();
    this.converter = new CodexAppServerEventConverter();
    this.client.on('notification', (message) => this.handleNotification(message));
    this.client.on('stderr', (text) => this.writeLog('codex_app_server.stderr', { text }));
  }

  async listThreads({ limit = 50, query = '' } = {}) {
    const max = clampLimit(limit);
    const liveSummaries = [...this.liveSessions.values()].map((session) => sessionToSummary(session));
    const desktopThreads = await this.listDesktopThreads({ limit: max, query });
    if (desktopThreads.length > 0) {
      const refreshedLiveSummaries = await this.refreshTerminalStatesForRunningDesktopThreads(liveSummaries, desktopThreads);
      return filterSessions(mergeDesktopAlignedSessions(refreshedLiveSummaries, desktopThreads), query).slice(0, max);
    }

    const response = await this.client.request('thread/list', {
      archived: false,
      limit: max,
      searchTerm: query || null,
      sortKey: 'updated_at',
      sortDirection: 'desc'
    });
    const threads = Array.isArray(response) ? response : (response?.data ?? response?.threads ?? []);
    const appServerThreads = threads
      .map((thread) => this.threadToSummary(thread))
      .filter((thread) => thread.id.length > 0);
    const merged = mergeSessions(liveSummaries, appServerThreads);
    return filterSessions(merged, query).slice(0, max);
  }

  async listDesktopThreads({ limit, query }) {
    if (!this.sessions || typeof this.sessions.listSessions !== 'function') {
      return [];
    }
    try {
      return await this.sessions.listSessions({ limit, query });
    } catch (error) {
      this.addServiceEvent('codex.desktop_threads.list_failed', {
        message: error.message ?? String(error)
      });
      return [];
    }
  }

  async refreshTerminalStatesForRunningDesktopThreads(liveSummaries, desktopThreads) {
    const liveById = new Map(liveSummaries.map((session) => [session.id, session]));
    const candidates = desktopThreads
      .filter((session) => {
        const desktopStatus = normalizeActivityStatus(session.runtimeState ?? session.activityStatus);
        if (!isRunningActivityStatus(desktopStatus)) {
          return false;
        }
        const liveStatus = normalizeActivityStatus(liveById.get(session.id)?.runtimeState ?? liveById.get(session.id)?.activityStatus);
        return !isTerminalActivityStatus(liveStatus);
      })
      .slice(0, MAX_RUNNING_DESKTOP_REFRESHES);

    for (const session of candidates) {
      const refreshed = await this.readLiveTerminalSnapshot(session.id);
      if (refreshed) {
        liveById.set(session.id, sessionToSummary(refreshed));
      }
    }

    return [...liveById.values()];
  }

  async getThread(threadId, { tail = 120 } = {}) {
    assertThreadId(threadId);
    const local = await this.readLocalThread(threadId, { tail });
    if (local) {
      const merged = mergeLocalThreadWithLiveState(local, this.liveSessions.get(threadId));
      if (isRunningActivityStatus(normalizeActivityStatus(merged.runtimeState ?? merged.activityStatus))) {
        const refreshed = await this.readLiveTerminalSnapshot(threadId);
        return limitSessionEntries(mergeLocalThreadWithLiveState(merged, refreshed), tail);
      }
      return limitSessionEntries(merged, tail);
    }

    const live = this.liveSessions.get(threadId);
    if (live) {
      return limitSessionEntries(live, tail);
    }

    const response = await this.client.request('thread/read', {
      threadId,
      includeTurns: true
    });
    const session = buildSessionSnapshot(response.thread ?? response, { threadId });
    this.liveSessions.set(threadId, session);
    return limitSessionEntries(session, tail);
  }

  async syncThread(threadId, { limit = 80, after = '', before = '' } = {}) {
    assertThreadId(threadId);
    const local = await this.readLocalThreadSync(threadId, { limit, after, before });
    if (local) {
      const merged = mergeLocalThreadWithLiveState(local, this.liveSessions.get(threadId));
      if (isRunningActivityStatus(normalizeActivityStatus(merged.runtimeState ?? merged.activityStatus))) {
        const refreshed = await this.readLiveTerminalSnapshot(threadId);
        return mergeLocalThreadWithLiveState(merged, refreshed);
      }
      return merged;
    }
    const fallback = await this.getThread(threadId, { tail: limit });
    return {
      ...fallback,
      sync: {
        mode: 'snapshot',
        source: fallback.source ?? 'app-server-live',
        filePath: fallback.filePath ?? '',
        fileSize: 0,
        fileUpdatedAt: fallback.activityUpdatedAt ?? fallback.updatedAt ?? '',
        cursorStart: '0',
        cursorEnd: String(fallback.entries?.length ?? 0),
        hasMoreBefore: false,
        hasMoreAfter: false,
        entryCount: fallback.entries?.length ?? 0
      }
    };
  }

  async deleteThread(threadId) {
    assertThreadId(threadId);
    const activeRunId = this.activeRunsByThreadId.get(threadId);
    if (activeRunId) {
      const run = this.runs.get(activeRunId);
      if (run && run.status !== 'completed' && run.status !== 'failed') {
        const error = new Error('会话正在进行中，请先中断或等待完成后再删除。');
        error.statusCode = 409;
        throw error;
      }
    }

    let deletion = {
      id: threadId,
      deletedFiles: [],
      archivedThreadCount: 0,
      removedIndexRecords: 0,
      removedGlobalStateEntries: 0,
      deletedAt: new Date().toISOString()
    };
    if (this.sessions && typeof this.sessions.deleteSession === 'function') {
      deletion = await this.sessions.deleteSession(threadId);
    }

    this.liveSessions.delete(threadId);
    this.activeRunsByThreadId.delete(threadId);
    for (const [turnId, runId] of [...this.activeRunsByTurnId.entries()]) {
      const run = this.runs.get(runId);
      if (run?.threadId === threadId) {
        this.activeRunsByTurnId.delete(turnId);
      }
    }
    this.addServiceEvent('codex.thread.deleted', {
      threadId,
      deletedFiles: deletion.deletedFiles?.length ?? 0,
      archivedThreadCount: deletion.archivedThreadCount ?? 0,
      removedIndexRecords: deletion.removedIndexRecords ?? 0
    });
    return deletion;
  }

  async readLiveTerminalSnapshot(threadId) {
    try {
      const response = await this.client.request('thread/read', {
        threadId,
        includeTurns: true
      });
      const runtimeState = runtimeStateFromDesktopThread(response.thread ?? response);
      if (!isTerminalActivityStatus(runtimeState)) {
        return null;
      }
      const session = buildSessionSnapshot(response.thread ?? response, { threadId });
      applyTerminalStateToSession(session, runtimeState, session.updatedAt || new Date().toISOString());
      session.activitySource = 'desktop-thread-read';
      session.runtimeSource = 'desktop-thread-read';
      this.liveSessions.set(threadId, session);
      this.addServiceEvent('codex.thread.live_terminal_overlay', {
        threadId,
        runtimeState,
        source: 'thread_read_for_local_running'
      });
      return session;
    } catch (error) {
      this.addServiceEvent('codex.thread.live_terminal_overlay_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async readLocalThread(threadId, { tail = 120 } = {}) {
    if (!this.sessions || typeof this.sessions.getSession !== 'function') {
      return null;
    }
    try {
      const local = await this.sessions.getSession(threadId, { tail });
      if (!local || local.detailAvailable === false || !Array.isArray(local.entries) || local.entries.length === 0) {
        return null;
      }
      return {
        ...local,
        source: local.source ?? 'session-file',
        activitySource: local.activitySource ?? 'session-file'
      };
    } catch (error) {
      this.addServiceEvent('codex.local_thread.read_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async readLocalThreadSync(threadId, { limit = 80, after = '', before = '' } = {}) {
    if (!this.sessions || typeof this.sessions.getSessionSync !== 'function') {
      return null;
    }
    try {
      const local = await this.sessions.getSessionSync(threadId, { limit, after, before });
      if (!local || local.detailAvailable === false || !Array.isArray(local.entries)) {
        return null;
      }
      return {
        ...local,
        source: local.source ?? 'session-file',
        activitySource: local.activitySource ?? 'session-file'
      };
    } catch (error) {
      this.addServiceEvent('codex.local_thread.sync_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async startThread({ projectId = '', cwd = '', prompt = '', model = '', reasoningEffort = '' } = {}) {
    const project = this.resolveProject(projectId, cwd);
    const resolvedCwd = resolveSafeProjectRoot(project, { action: '手机端新建 Codex 会话' });
    const response = await this.client.request('thread/start', {
      cwd: resolvedCwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      model: this.optionalModel(model),
      threadSource: 'user'
    });
    const thread = response.thread;
    if (!thread?.id) {
      throw new Error('Codex app-server did not return thread.id');
    }
    const session = buildSessionSnapshot(thread, { threadId: thread.id });
    this.liveSessions.set(thread.id, session);
    if (prompt.trim().length === 0) {
      return { thread: session, run: null };
    }
    const run = await this.sendMessage({
      threadId: thread.id,
      text: prompt,
      projectId: project?.id ?? projectId,
      createdThreadId: thread.id,
      model,
      reasoningEffort
    });
    return { thread: this.liveSessions.get(thread.id) ?? session, run };
  }

  async sendMessage({ threadId, text, projectId = '', createdThreadId = null, model = '', reasoningEffort = '' }) {
    assertThreadId(threadId);
    const prompt = String(text ?? '').trim();
    if (prompt.length === 0) {
      const error = new Error('消息不能为空');
      error.statusCode = 400;
      throw error;
    }

    const run = this.createRun({ threadId, prompt, projectId, createdThreadId, model, reasoningEffort });
    this.addEntry(threadId, {
      timestamp: new Date().toISOString(),
      type: 'userMessage',
      role: 'user',
      text: prompt
    });
    this.addRunEvent(run, 'codex.user.message', { threadId, text: prompt });
    this.openDesktopThread(run, 'submitted');
    void this.runTurn(run).catch((error) => this.failRun(run, error));
    return this.serializeRun(run);
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('Unknown Codex run');
      error.statusCode = 404;
      throw error;
    }
    return this.serializeRun(run);
  }

  async interruptRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('Unknown Codex run');
      error.statusCode = 404;
      throw error;
    }
    if (!run.turnId) {
      return this.serializeRun(run);
    }
    await this.client.request('turn/interrupt', {
      threadId: run.threadId,
      turnId: run.turnId
    });
    this.addRunEvent(run, 'codex.turn.interrupted', { threadId: run.threadId, turnId: run.turnId });
    this.removeLiveActivity(run.threadId, run.turnId);
    run.status = 'failed';
    run.error = '已中断当前回复';
    run.updatedAt = new Date().toISOString();
    this.markLiveSessionTerminal(run.threadId, 'interrupted', run.updatedAt, run.turnId);
    return this.serializeRun(run);
  }

  createRun({ threadId, prompt, projectId, createdThreadId, model, reasoningEffort }) {
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(),
      projectId: projectId || 'codex',
      prompt,
      threadId,
      createdThreadId,
      turnId: null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      session: this.liveSessions.get(threadId) ?? null,
      model: normalizeModelId(model),
      reasoningEffort: normalizeReasoningEffort(reasoningEffort),
      error: ''
    };
    this.runs.set(run.id, run);
    return run;
  }

  async runTurn(run) {
    run.status = 'running';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'codex.turn.preparing', { threadId: run.threadId });

    try {
      await this.client.request('thread/resume', {
        threadId: run.threadId,
        cwd: null,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        model: this.optionalModel(run.model)
      });
    } catch (error) {
      this.addRunEvent(run, 'codex.thread.resume.warning', { threadId: run.threadId, message: error.message });
    }

    const response = await this.client.request('turn/start', {
      threadId: run.threadId,
      cwd: null,
      input: [{
        type: 'text',
        text: run.prompt
      }],
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(this.sandbox),
      model: this.optionalModel(run.model),
      effort: normalizeReasoningEffort(run.reasoningEffort)
    });
    run.turnId = response?.turn?.id ?? null;
    this.activeRunsByThreadId.set(run.threadId, run.id);
    if (run.turnId) {
      this.activeRunsByTurnId.set(run.turnId, run.id);
    }
    this.addRunEvent(run, 'codex.turn.started', sanitize(response));
  }

  async handleNotification(message) {
    const threadId = extractThreadIdFromNotification(message);
    const turnId = extractTurnIdFromNotification(message);
    const run = this.resolveRunForNotification(threadId, turnId);
    if (!run) {
      this.addServiceEvent('codex.app_server.notification.unmatched', {
        method: message?.method ?? '',
        threadId,
        turnId,
        activeThreadIds: [...this.activeRunsByThreadId.keys()],
        activeTurnIds: [...this.activeRunsByTurnId.keys()],
        paramsShape: summarizeShape(message?.params)
      });
      return;
    }

    const converted = this.converter.convert(message);
    for (const item of converted) {
      if (item.entry) {
        this.applyEntry(run.threadId, item.entry);
      }
      this.addRunEvent(run, item.type, item.payload ?? sanitize(message));
      if (item.failed) {
        run.status = 'failed';
        run.error = item.entry?.text ?? 'Codex 回合失败';
      }
      if (item.terminal) {
        const terminalStatus = terminalStatusFromConvertedEvent(item);
        this.markLiveSessionTerminal(run.threadId, terminalStatus, new Date().toISOString(), run.turnId);
        this.removeLiveActivity(run.threadId, run.turnId);
        if (run.status !== 'failed') {
          run.status = 'completed';
        }
        await this.finishRun(run);
      }
    }
  }

  resolveRunForNotification(threadId, turnId) {
    if (turnId && this.activeRunsByTurnId.has(turnId)) {
      return this.runs.get(this.activeRunsByTurnId.get(turnId)) ?? null;
    }
    if (threadId && this.activeRunsByThreadId.has(threadId)) {
      return this.runs.get(this.activeRunsByThreadId.get(threadId)) ?? null;
    }
    return null;
  }

  async finishRun(run) {
    if (run.turnId) {
      this.activeRunsByTurnId.delete(run.turnId);
    }
    this.activeRunsByThreadId.delete(run.threadId);
    try {
      const response = await this.client.request('thread/read', {
        threadId: run.threadId,
        includeTurns: true
      });
      const session = buildSessionSnapshot(response.thread, {
        threadId: run.threadId,
        prompt: run.prompt
      });
      applyTerminalStateToSession(session, run.status === 'failed' ? 'failed' : 'completed', run.updatedAt || new Date().toISOString(), run.turnId);
      const merged = preserveClientNoticeEntries(this.liveSessions.get(run.threadId), session);
      this.liveSessions.set(run.threadId, merged);
      run.session = merged;
      this.addRunEvent(run, 'codex.thread.read', summarizeThreadForEvent(response));
    } catch (error) {
      this.addRunEvent(run, 'codex.thread.read.failed', { threadId: run.threadId, message: error.message });
    }
    run.updatedAt = new Date().toISOString();
    this.openDesktopThread(run, 'completed');
  }

  failRun(run, error) {
    run.status = 'failed';
    run.error = error.message ?? String(error);
    run.updatedAt = new Date().toISOString();
    this.removeLiveActivity(run.threadId, run.turnId);
    this.markLiveSessionTerminal(run.threadId, 'failed', run.updatedAt, run.turnId);
    const notice = classifyCodexClientNotice(error, { source: 'codex.run.failed' });
    if (notice) {
      this.addEntry(run.threadId, createCodexClientNoticeEntry(error, {
        notice,
        threadId: run.threadId
      }));
    } else {
      this.addEntry(run.threadId, {
        timestamp: new Date().toISOString(),
        type: 'error',
        role: 'system',
        text: run.error
      });
    }
    this.addRunEvent(run, 'codex.run.failed', notice
      ? { threadId: run.threadId, message: run.error, notice }
      : { threadId: run.threadId, message: run.error });
  }

  addRunEvent(run, type, payload) {
    const event = {
      id: randomUUID(),
      taskId: run.id,
      type,
      payload: payload ?? {},
      createdAt: new Date().toISOString()
    };
    run.events.push(event);
    run.updatedAt = event.createdAt;
    this.eventBus?.publish?.(run.id, event);
    void this.writeLog(type, { runId: run.id, threadId: run.threadId, payload: event.payload });
    return event;
  }

  openDesktopThread(run, stage) {
    if (!this.autoOpenDesktop || typeof this.desktopOpener !== 'function') {
      return;
    }
    void Promise.resolve()
      .then(() => this.desktopOpener(run.threadId))
      .then((result) => {
        this.addRunEvent(run, 'codex.desktop.opened', {
          threadId: run.threadId,
          stage,
          desktop: sanitize(result)
        });
      })
      .catch((error) => {
        this.addRunEvent(run, 'codex.desktop.open_failed', {
          threadId: run.threadId,
          stage,
          message: error.message ?? String(error)
        });
      });
  }

  addEntry(threadId, entry) {
    const existing = this.liveSessions.get(threadId);
    const session = existing ?? {
      id: threadId,
      title: entry.text.slice(0, 80) || '未命名会话',
      updatedAt: entry.timestamp,
      relativeTime: '刚刚',
      projectRoot: '',
      projectLabel: '未归类',
      source: 'app-server-live',
      pinned: false,
      detailAvailable: true,
      filePath: '',
      entries: [],
      entryCount: 0
    };
    session.entries = [...(session.entries ?? []), entry];
    session.entryCount = session.entries.length;
    session.updatedAt = entry.timestamp;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
    return session;
  }

  applyEntry(threadId, entry) {
    const session = this.liveSessions.get(threadId);
    if (!session) {
      return this.addEntry(threadId, entry);
    }
    if (isLiveActivityEntry(entry)) {
      session.entries = withoutLiveActivity(session.entries ?? [], entry.turnId);
      session.entries.push(entry);
    } else {
      const entries = session.entries ?? [];
      const liveEntry = entries.find((candidate) => isLiveActivityEntry(candidate)) ?? null;
      const stableEntries = entries.filter((candidate) => !isLiveActivityEntry(candidate));
      const lastStable = stableEntries.at(-1);
      if (!(lastStable && lastStable.role === entry.role && lastStable.text === entry.text)) {
        stableEntries.push(entry);
      }
      session.entries = liveEntry ? [...stableEntries, liveEntry] : stableEntries;
    }
    session.entryCount = session.entries.length;
    session.updatedAt = entry.timestamp;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
    return session;
  }

  removeLiveActivity(threadId, turnId = null) {
    const session = this.liveSessions.get(threadId);
    if (!session?.entries) {
      return;
    }
    const nextEntries = withoutLiveActivity(session.entries, turnId);
    if (nextEntries.length === session.entries.length) {
      return;
    }
    session.entries = nextEntries;
    session.entryCount = nextEntries.length;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
  }

  markLiveSessionTerminal(threadId, status, timestamp = new Date().toISOString(), turnId = null) {
    const session = this.liveSessions.get(threadId);
    if (!session) {
      return null;
    }
    applyTerminalStateToSession(session, status, timestamp, turnId);
    this.liveSessions.set(threadId, session);
    return session;
  }

  serializeRun(run) {
    return {
      id: run.id,
      projectId: run.projectId,
      prompt: run.prompt,
      codexSessionId: run.threadId,
      createdCodexSessionId: run.createdThreadId,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      desktopSync: {
        status: 'app_server_official',
        desktopLive: false,
        mode: run.createdThreadId ? 'new' : 'resume',
        message: '已通过 Codex 官方 app-server 会话协议提交。',
        reason: '手机端现在以 app-server thread 为准，不再依赖桌面窗口注入。'
      },
      session: this.liveSessions.get(run.threadId) ?? run.session,
      events: run.events,
      eventCount: run.events.length,
      latestEvent: run.events.at(-1) ?? null,
      error: run.error
    };
  }

  threadToSummary(thread) {
    const id = String(thread?.id ?? '');
    const cwd = String(thread?.cwd ?? '');
    const updatedAt = timestampToIso(thread?.updatedAt ?? thread?.createdAt) || new Date().toISOString();
    return {
      id,
      title: cleanTitle(thread?.name ?? thread?.preview ?? thread?.firstUserMessage ?? '未命名会话'),
      updatedAt,
      relativeTime: formatRelativeTime(Date.parse(updatedAt)),
      projectRoot: cwd,
      projectLabel: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '未归类',
      source: 'app-server',
      activitySource: 'app-server',
      pinned: false,
      detailAvailable: true
    };
  }

  resolveProject(projectId, cwd = '') {
    if (projectId) {
      return this.projects.find((project) => project.id === projectId) ?? this.resolveProjectByRoot(cwd);
    }
    return this.resolveProjectByRoot(cwd) ?? this.projects[0] ?? null;
  }

  resolveProjectByRoot(cwd = '') {
    const requested = String(cwd ?? '').trim();
    if (requested.length === 0) {
      return null;
    }
    return this.projects.find((project) => {
      return isSameOrChildPath(requested, project.root) || isSameOrChildPath(project.root, requested);
    }) ?? null;
  }

  optionalModel(model = '') {
    const requested = normalizeModelId(model);
    if (requested.length > 0) {
      return requested;
    }
    const value = this.model.trim();
    return value.length > 0 ? value : null;
  }

  async writeLog(event, data) {
    if (!this.logger?.write) {
      return;
    }
    await this.logger.write('bridge', 'info', event, data).catch(() => {});
  }

  addServiceEvent(type, payload) {
    void this.writeLog(type, payload);
  }
}

function assertThreadId(threadId) {
  if (!VALID_THREAD_ID.test(String(threadId ?? ''))) {
    const error = new Error('Invalid Codex thread id');
    error.statusCode = 400;
    throw error;
  }
}

function clampLimit(value, max = 100) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(parsed, 1), max);
}

function timestampToIso(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 80) {
    return text || '未命名会话';
  }
  return `${text.slice(0, 80)}...`;
}

function sessionToSummary(session) {
  const runtimeState = normalizeActivityStatus(session.runtimeState ?? session.activityStatus) || 'idle';
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    relativeTime: session.relativeTime ?? '',
    projectRoot: session.projectRoot ?? '',
    projectLabel: session.projectLabel ?? '未归类',
    source: session.source ?? 'app-server-live',
    activitySource: session.runtimeSource ?? session.activitySource ?? 'app-server-live',
    activityStatus: runtimeState,
    activityUpdatedAt: session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? '',
    runtimeState,
    runtimeSource: session.runtimeSource ?? session.activitySource ?? 'app-server-live',
    runtimeUpdatedAt: session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? '',
    canInterrupt: session.canInterrupt === true || runtimeState === 'running',
    terminalReason: terminalReasonForStatus(runtimeState),
    lastVisibleRole: session.lastVisibleRole ?? '',
    pinned: session.pinned ?? false,
    detailAvailable: true
  };
}

function mergeSessions(primary, secondary) {
  const byId = new Map();
  for (const item of [...secondary, ...primary]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => {
    return Date.parse(right.updatedAt || '0') - Date.parse(left.updatedAt || '0');
  });
}

function mergeDesktopAlignedSessions(liveSessions, desktopSessions) {
  const liveById = new Map(liveSessions.map((session) => [session.id, session]));
  const desktopIds = new Set(desktopSessions.map((session) => session.id));
  const liveOnly = liveSessions
    .filter((session) => !desktopIds.has(session.id))
    .sort((left, right) => Date.parse(right.updatedAt || '0') - Date.parse(left.updatedAt || '0'));
  const desktopAligned = desktopSessions.map((desktop) => {
    const live = liveById.get(desktop.id);
    if (!live) {
      return desktop;
    }
    const runtime = mergeActivityState(live, desktop);
    const runtimeState = runtime.status;
    const runtimeUpdatedAt = runtime.updatedAt;
    const terminal = isTerminalActivityStatus(runtimeState);
    return {
      ...desktop,
      updatedAt: live.updatedAt || desktop.updatedAt,
      relativeTime: live.relativeTime || desktop.relativeTime,
      source: live.source || desktop.source,
      activitySource: runtime.source,
      activityStatus: runtimeState,
      activityUpdatedAt: runtimeUpdatedAt,
      runtimeState,
      runtimeSource: runtime.source,
      runtimeUpdatedAt,
      canInterrupt: !terminal && (runtimeState === 'running' || runtimeState === 'waiting_approval' || live.canInterrupt === true || desktop.canInterrupt === true),
      terminalReason: terminalReasonForStatus(runtimeState),
      lastVisibleRole: live.lastVisibleRole || desktop.lastVisibleRole || '',
      detailAvailable: desktop.detailAvailable !== false
    };
  });
  return [...liveOnly, ...desktopAligned];
}

function mergeLocalThreadWithLiveState(localSession, liveSession) {
  const liveStatus = normalizeActivityStatus(liveSession?.runtimeState ?? liveSession?.activityStatus);
  if (!isTerminalActivityStatus(liveStatus)) {
    return localSession;
  }
  const localStatus = normalizeActivityStatus(localSession?.runtimeState ?? localSession?.activityStatus);
  if (!isRunningActivityStatus(localStatus) && !isLiveActivityEntry(localSession?.entries?.at(-1))) {
    return localSession;
  }
  const liveUpdatedAt = liveSession?.runtimeUpdatedAt || liveSession?.activityUpdatedAt || liveSession?.updatedAt || '';
  const localUpdatedAt = localSession?.runtimeUpdatedAt || localSession?.activityUpdatedAt || localSession?.updatedAt || '';
  const liveSource = liveSession?.runtimeSource || liveSession?.activitySource || 'app-server-live';
  if (liveSource !== 'desktop-thread-read' && isActivityStateNewerByMoreThan(
    { status: localStatus, updatedAt: localUpdatedAt },
    { status: liveStatus, updatedAt: liveUpdatedAt },
    3000
  )) {
    return localSession;
  }
  const entries = withoutLiveActivity(localSession.entries ?? []);
  return {
    ...localSession,
    entries,
    entryCount: entries.length,
    activitySource: liveSession.runtimeSource || liveSession.activitySource || 'app-server-live',
    activityStatus: liveStatus,
    activityUpdatedAt: liveUpdatedAt || localUpdatedAt,
    runtimeState: liveStatus,
    runtimeSource: liveSession.runtimeSource || liveSession.activitySource || 'app-server-live',
    runtimeUpdatedAt: liveUpdatedAt || localUpdatedAt,
    canInterrupt: false,
    terminalReason: terminalReasonForStatus(liveStatus) || liveSession.terminalReason || liveStatus
  };
}

function applyTerminalStateToSession(session, status, timestamp = new Date().toISOString(), turnId = null) {
  const terminalStatus = normalizeActivityStatus(status) || 'completed';
  const normalized = isTerminalActivityStatus(terminalStatus) ? terminalStatus : 'completed';
  session.activitySource = 'app-server-live';
  session.activityStatus = normalized;
  session.activityUpdatedAt = timestamp;
  session.runtimeState = normalized;
  session.runtimeSource = 'app-server-live';
  session.runtimeUpdatedAt = timestamp;
  session.canInterrupt = false;
  session.terminalReason = terminalReasonForStatus(normalized) || normalized;
  session.entries = withoutLiveActivity(session.entries ?? [], turnId);
  session.entryCount = session.entries.length;
  session.updatedAt = latestIso(session.updatedAt, timestamp);
}

function terminalStatusFromConvertedEvent(item) {
  const raw = item?.payload?.params?.turn?.status
    ?? item?.payload?.params?.status
    ?? item?.payload?.status
    ?? '';
  const normalized = normalizeDesktopTurnStatus(raw);
  if (isTerminalActivityStatus(normalized)) {
    return normalized;
  }
  if (item?.failed === true || item?.type === 'codex.turn.failed') {
    return 'failed';
  }
  return 'completed';
}

function runtimeStateFromDesktopThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const latest = [...turns].reverse().find((turn) => String(turn?.status ?? '').trim().length > 0);
  if (!latest) {
    return '';
  }
  const mapped = normalizeDesktopTurnStatus(latest.status);
  if (mapped) {
    return mapped;
  }
  const status = String(latest.status ?? '').trim().toLowerCase().replace(/[-_ ]/g, '');
  if (status === 'inprogress' || status === 'running' || status === 'active') {
    return 'running';
  }
  return '';
}

function normalizeDesktopTurnStatus(status) {
  const value = String(status ?? '').trim().toLowerCase().replace(/[-_ ]/g, '');
  if (value === 'failed' || value === 'error') {
    return 'failed';
  }
  if (value === 'interrupted' || value === 'cancelled' || value === 'canceled' || value === 'aborted') {
    return 'interrupted';
  }
  if (value === 'completed' || value === 'complete' || value === 'success' || value === 'succeeded') {
    return 'completed';
  }
  return '';
}

function mergeActivityState(liveSession, desktopSession) {
  const live = activityStateCandidate(liveSession, 'app-server-live');
  const desktop = activityStateCandidate(desktopSession, 'session-file');
  const chosen = chooseActivityState(live, desktop);
  return {
    status: chosen.status || 'idle',
    source: chosen.source || 'unknown',
    updatedAt: chosen.updatedAt || latestIso(live.updatedAt, desktop.updatedAt)
  };
}

function activityStateCandidate(session, fallbackSource) {
  const status = normalizeActivityStatus(session.runtimeState ?? session.activityStatus);
  const explicitUpdatedAt = session.runtimeUpdatedAt || session.activityUpdatedAt || '';
  return {
    status,
    source: session.runtimeSource || session.activitySource || fallbackSource,
    updatedAt: explicitUpdatedAt || session.updatedAt || '',
    explicitUpdatedAt
  };
}

function chooseActivityState(left, right) {
  if (!left.status) {
    return right;
  }
  if (!right.status) {
    return left;
  }
  if (left.status === right.status) {
    return newerActivityState(left, right);
  }

  const leftTerminal = isTerminalActivityStatus(left.status);
  const rightTerminal = isTerminalActivityStatus(right.status);
  const leftRunning = isRunningActivityStatus(left.status);
  const rightRunning = isRunningActivityStatus(right.status);
  const leftIdle = left.status === 'idle';
  const rightIdle = right.status === 'idle';

  if ((leftTerminal && rightRunning) || (rightTerminal && leftRunning)) {
    const terminal = leftTerminal ? left : right;
    const running = leftRunning ? left : right;
    if (isActivityStateNewerByMoreThan(running, terminal, 3000)) {
      return running;
    }
    return terminal;
  }

  if ((leftRunning && rightIdle) || (rightRunning && leftIdle)) {
    const running = leftRunning ? left : right;
    const idle = leftIdle ? left : right;
    if (!idle.explicitUpdatedAt) {
      return running;
    }
    return newerActivityState(running, idle);
  }

  return newerActivityState(left, right);
}

function newerActivityState(left, right) {
  const leftMs = Date.parse(left.updatedAt || '');
  const rightMs = Date.parse(right.updatedAt || '');
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs > rightMs ? left : right;
  }
  if (Number.isFinite(leftMs) && !Number.isFinite(rightMs)) {
    return left;
  }
  if (!Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return right;
  }
  const leftPriority = activityStatusPriority(left.status);
  const rightPriority = activityStatusPriority(right.status);
  return leftPriority >= rightPriority ? left : right;
}

function isActivityStateNewerByMoreThan(candidate, baseline, thresholdMs) {
  const candidateMs = Date.parse(candidate.updatedAt || '');
  const baselineMs = Date.parse(baseline.updatedAt || '');
  return Number.isFinite(candidateMs) && Number.isFinite(baselineMs) && candidateMs - baselineMs > thresholdMs;
}

function activityStatusPriority(status) {
  if (status === 'failed') {
    return 50;
  }
  if (status === 'interrupted') {
    return 45;
  }
  if (status === 'completed') {
    return 40;
  }
  if (status === 'waiting_approval') {
    return 30;
  }
  if (status === 'running') {
    return 20;
  }
  if (status === 'idle') {
    return 10;
  }
  return 0;
}

function isTerminalActivityStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function isRunningActivityStatus(status) {
  return status === 'running' || status === 'waiting_approval';
}

function normalizeActivityStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  if (status === 'running' || status === 'waiting_approval' || status === 'interrupted' || status === 'failed' || status === 'completed' || status === 'idle') {
    return status;
  }
  return '';
}

function terminalReasonForStatus(status) {
  const normalized = normalizeActivityStatus(status);
  if (normalized === 'completed' || normalized === 'interrupted' || normalized === 'failed') {
    return normalized;
  }
  return '';
}

function latestIso(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const leftMs = Date.parse(leftText || '0');
  const rightMs = Date.parse(rightText || '0');
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs >= rightMs ? leftText : rightText;
  }
  return leftText || rightText;
}

function filterSessions(sessions, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) {
    return sessions;
  }
  return sessions.filter((session) => {
    return `${session.id} ${session.title} ${session.projectLabel} ${session.projectRoot}`.toLowerCase().includes(normalized);
  });
}

function sandboxPolicyFromMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (normalized === 'danger-full-access' || normalized === 'dangerfullaccess') {
    return { type: 'dangerFullAccess' };
  }
  if (normalized === 'read-only' || normalized === 'readonly') {
    return { type: 'readOnly' };
  }
  return { type: 'workspaceWrite', networkAccess: true };
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return null;
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : null;
}

function limitSessionEntries(session, tail) {
  const limit = clampLimit(tail, 200);
  const entries = (session.entries ?? []).slice(-limit);
  return {
    ...session,
    entries,
    entryCount: entries.length
  };
}

function withoutLiveActivity(entries, turnId = null) {
  return entries.filter((entry) => {
    if (!isLiveActivityEntry(entry)) {
      return true;
    }
    if (!turnId) {
      return false;
    }
    return entry.turnId && entry.turnId !== turnId;
  });
}

function preserveClientNoticeEntries(existing, snapshot) {
  if (!existing?.entries?.length) {
    return snapshot;
  }
  const notices = existing.entries.filter((entry) => entry.type === 'codex_client_notice');
  if (notices.length === 0) {
    return snapshot;
  }
  const entries = [...(snapshot.entries ?? [])];
  for (const notice of notices) {
    const duplicate = entries.some((entry) => {
      return entry.type === notice.type
        && entry.role === notice.role
        && entry.text === notice.text;
    });
    if (!duplicate) {
      entries.push(notice);
    }
  }
  return {
    ...snapshot,
    entries,
    entryCount: entries.length
  };
}

function formatRelativeTime(updatedAtMs) {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return '';
  }
  const diffMs = Date.now() - updatedAtMs;
  if (diffMs < 60 * 1000) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function extractThreadIdFromNotification(message) {
  const params = message?.params ?? {};
  return firstString([
    params.threadId,
    params.thread_id,
    params.threadID,
    params.sessionId,
    params.session_id,
    params.conversationId,
    params.conversation_id,
    params.thread?.id,
    params.thread?.threadId,
    params.thread?.thread_id,
    params.turn?.threadId,
    params.turn?.thread_id,
    params.turn?.thread?.id,
    params.item?.threadId,
    params.item?.thread_id,
    params.item?.thread?.id,
    params.event?.threadId,
    params.event?.thread_id,
    params.event?.thread?.id,
    params.delta?.threadId,
    params.delta?.thread_id
  ]);
}

export function extractTurnIdFromNotification(message) {
  const params = message?.params ?? {};
  return firstString([
    params.turnId,
    params.turn_id,
    params.turnID,
    params.responseId,
    params.response_id,
    params.turn?.id,
    params.turn?.turnId,
    params.turn?.turn_id,
    params.item?.turnId,
    params.item?.turn_id,
    params.item?.turn?.id,
    params.event?.turnId,
    params.event?.turn_id,
    params.event?.turn?.id,
    params.delta?.turnId,
    params.delta?.turn_id
  ]);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function summarizeShape(value, depth = 0) {
  if (!value || typeof value !== 'object') {
    return typeof value;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? '[array]' : '[object]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => summarizeShape(item, depth + 1));
  }
  const shape = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    const child = value[key];
    shape[key] = child && typeof child === 'object' ? summarizeShape(child, depth + 1) : typeof child;
  }
  return shape;
}
