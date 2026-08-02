import fs from 'node:fs';
import path from 'node:path';

const ACTIVE_STATUSES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'interrupting',
  'reconciling',
  'recovering'
]);

export class CodexAppServerRunJournal {
  constructor(options = {}) {
    this.filePath = String(options.filePath ?? '').trim();
    this.fs = options.fsModule ?? fs;
  }

  load() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : parsed?.runs;
      if (!Array.isArray(entries)) {
        return [];
      }
      return entries
        .filter((entry) => entry && typeof entry === 'object' && ACTIVE_STATUSES.has(String(entry.status ?? '')))
        .map((entry) => restoreRun(entry));
    } catch {
      return [];
    }
  }

  persist(runs = []) {
    if (!this.filePath) {
      return;
    }
    const recoverable = runs
      .filter((run) => run && ACTIVE_STATUSES.has(String(run.status ?? '')))
      .map((run) => snapshotRun(run));
    const directory = path.dirname(this.filePath);
    try {
      this.fs.mkdirSync(directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      this.fs.writeFileSync(temporary, JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        runs: recoverable
      }, null, 2), 'utf8');
      this.fs.renameSync(temporary, this.filePath);
    } catch {
      // A recovery journal must never make a live Codex turn fail. The bridge
      // retains in-memory state and exposes the persistence failure separately.
    }
  }
}

function snapshotRun(run) {
  return {
    id: String(run.id ?? ''),
    threadId: String(run.threadId ?? run.codexSessionId ?? ''),
    turnId: nullableString(run.turnId ?? run.activeCodexTurnId),
    projectId: String(run.projectId ?? 'codex'),
    submissionId: nullableString(run.submissionId),
    status: String(run.status ?? 'running'),
    createdAt: String(run.createdAt ?? new Date().toISOString()),
    updatedAt: String(run.updatedAt ?? new Date().toISOString()),
    model: String(run.model ?? ''),
    reasoningEffort: String(run.reasoningEffort ?? ''),
    promptLength: Number(run.promptLength ?? String(run.prompt ?? '').length) || 0,
    createdThreadId: nullableString(run.createdThreadId),
    deliveryMode: normalizeDeliveryMode(run.deliveryMode),
    generation: Number(run.generation ?? 0) || 0
  };
}

function restoreRun(entry) {
  return {
    id: String(entry.id ?? ''),
    threadId: String(entry.threadId ?? ''),
    turnId: nullableString(entry.turnId),
    projectId: String(entry.projectId ?? 'codex'),
    submissionId: nullableString(entry.submissionId),
    status: 'recovering',
    createdAt: String(entry.createdAt ?? new Date().toISOString()),
    updatedAt: String(entry.updatedAt ?? new Date().toISOString()),
    model: String(entry.model ?? ''),
    reasoningEffort: String(entry.reasoningEffort ?? ''),
    prompt: '',
    promptLength: Number(entry.promptLength ?? 0) || 0,
    createdThreadId: nullableString(entry.createdThreadId),
    deliveryMode: normalizeDeliveryMode(entry.deliveryMode),
    generation: Number(entry.generation ?? 0) || 0
  };
}

function nullableString(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

function normalizeDeliveryMode(value) {
  return String(value ?? '').trim() === 'desktop_fallback' ? 'desktop_fallback' : 'app_server';
}
