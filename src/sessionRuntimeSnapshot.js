import { randomUUID } from 'node:crypto';

const ACTIVE_STATES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'recovering'
]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted']);

export class SessionRuntimeSnapshotTracker {
  constructor(options = {}) {
    this.epoch = String(options.epoch ?? randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.revision = 0;
    this.lastFingerprint = '';
  }

  build({ sessions = [], activeRuns = [], officialStates = [], stale = false } = {}) {
    const activeByThread = latestActiveRunByThread(activeRuns);
    const officialByThread = runtimeStateByThread(officialStates);
    const runtimeSessions = sessions.map((session) => {
      const threadId = String(session?.id ?? session?.threadId ?? '').trim();
      const activeRun = activeByThread.get(threadId) ?? null;
      const officialState = officialByThread.get(threadId) ?? null;
      return runtimeSession(session, activeRun, officialState);
    });
    const fingerprint = JSON.stringify(runtimeSessions);
    if (this.revision === 0 || fingerprint !== this.lastFingerprint) {
      this.revision += 1;
      this.lastFingerprint = fingerprint;
    }
    return {
      schemaVersion: 1,
      epoch: this.epoch,
      revision: this.revision,
      generatedAt: this.now(),
      stale: stale === true,
      sessions: runtimeSessions
    };
  }
}

export function normalizeRuntimeSnapshotState(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'processing') {
    return 'running';
  }
  if (normalized === 'complete' || normalized === 'done') {
    return 'completed';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'aborted') {
    return 'interrupted';
  }
  if (ACTIVE_STATES.has(normalized) || TERMINAL_STATES.has(normalized) || normalized === 'idle') {
    return normalized;
  }
  return 'idle';
}

function runtimeSession(session, activeRun, officialState) {
  const threadId = String(session?.id ?? session?.threadId ?? '').trim();
  const projectedState = normalizeRuntimeSnapshotState(session?.runtimeState ?? session?.activityStatus);
  const state = activeRun
    ? normalizeRuntimeSnapshotState(activeRun.status ?? activeRun.runtime?.state)
    : officialState
      ? normalizeRuntimeSnapshotState(officialState.state ?? officialState.status)
      : projectedState;
  const activeTurnId = activeRun
    ? String(activeRun.turnId ?? activeRun.activeCodexTurnId ?? '').trim()
    : officialState
      ? String(officialState.activeTurnId ?? '').trim()
      : String(session?.activeTurnId ?? session?.activityTurnId ?? '').trim();
  const stateUpdatedAt = String(
    activeRun?.updatedAt
      ?? officialState?.updatedAt
      ?? session?.runtimeUpdatedAt
      ?? session?.activityUpdatedAt
      ?? session?.updatedAt
      ?? ''
  );
  const source = activeRun
    ? 'app-server-run'
    : officialState
      ? String(officialState.source ?? 'desktop-app-server')
      : String(session?.runtimeSource ?? session?.activitySource ?? session?.source ?? 'unknown');
  return {
    threadId,
    title: String(session?.title ?? '未命名会话'),
    projectRoot: String(session?.projectRoot ?? ''),
    projectLabel: String(session?.projectLabel ?? '未归类'),
    sidebarSection: String(session?.sidebarSection ?? 'recent'),
    pinned: session?.pinned === true,
    updatedAt: String(session?.updatedAt ?? stateUpdatedAt),
    relativeTime: String(session?.relativeTime ?? ''),
    state,
    stateUpdatedAt,
    source,
    activeTurnId,
    canInterrupt: activeRun
      ? ACTIVE_STATES.has(state)
      : officialState
        ? officialState.canInterrupt === true || ACTIVE_STATES.has(state)
        : session?.canInterrupt === true,
    terminalReason: TERMINAL_STATES.has(state)
      ? String(officialState?.terminalReason ?? session?.terminalReason ?? state)
      : '',
    lastVisibleRole: String(session?.lastVisibleRole ?? ''),
    detailAvailable: session?.detailAvailable !== false
  };
}

function runtimeStateByThread(states) {
  const byThread = new Map();
  for (const state of states) {
    const threadId = String(state?.threadId ?? state?.id ?? '').trim();
    if (threadId) {
      byThread.set(threadId, state);
    }
  }
  return byThread;
}

function latestActiveRunByThread(runs) {
  const byThread = new Map();
  for (const run of runs) {
    const state = normalizeRuntimeSnapshotState(run?.status ?? run?.runtime?.state);
    if (!ACTIVE_STATES.has(state)) {
      continue;
    }
    const threadId = String(run?.threadId ?? run?.codexSessionId ?? '').trim();
    if (!threadId) {
      continue;
    }
    const current = byThread.get(threadId);
    if (!current || isNewerRun(run, current)) {
      byThread.set(threadId, run);
    }
  }
  return byThread;
}

function isNewerRun(candidate, current) {
  const candidateMs = Date.parse(String(candidate?.updatedAt ?? candidate?.createdAt ?? ''));
  const currentMs = Date.parse(String(current?.updatedAt ?? current?.createdAt ?? ''));
  if (Number.isFinite(candidateMs) && Number.isFinite(currentMs) && candidateMs !== currentMs) {
    return candidateMs > currentMs;
  }
  return String(candidate?.id ?? '') > String(current?.id ?? '');
}
