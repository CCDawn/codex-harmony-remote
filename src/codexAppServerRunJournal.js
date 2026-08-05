import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CURRENT_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;

const ACTIVE_STATUSES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'interrupting',
  'reconciling',
  'recovering'
]);

// Codex thread and turn ids are UUIDs. Anything else (probe fixtures,
// synthetic ids such as "019e-thread" or "turn-1") is not recoverable and
// must never reach the production-style active-run journal.
const CODEX_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexUuid(value) {
  return CODEX_UUID_PATTERN.test(String(value ?? '').trim());
}

export function isRecoverableRunIdentifier(run) {
  if (!run) {
    return false;
  }
  return Boolean(
    isCodexUuid(run.threadId ?? run.codexSessionId)
    && isCodexUuid(run.turnId ?? run.activeCodexTurnId)
  );
}

export class CodexAppServerRunJournal {
  constructor(options = {}) {
    this.filePath = String(options.filePath ?? '').trim();
    this.fs = options.fsModule ?? fs;
    this.epoch = String(options.epoch ?? options.runtimeSnapshotEpoch ?? randomUUID());
    this.journalId = String(options.journalId ?? randomUUID());
  }

  load() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      const schemaVersion = Number(parsed?.schemaVersion ?? LEGACY_SCHEMA_VERSION);
      if (!Number.isInteger(schemaVersion) || schemaVersion > CURRENT_SCHEMA_VERSION) {
        // A journal written by a newer bridge is outside this reader's
        // reconciliation contract: never guess its entry shape.
        return [];
      }
      const entries = Array.isArray(parsed) ? parsed : parsed?.runs;
      if (!Array.isArray(entries)) {
        return [];
      }
      const recoverable = entries
        .filter((entry) => entry && typeof entry === 'object' && ACTIVE_STATUSES.has(String(entry.status ?? '')))
        .filter((entry) => isRecoverableRunIdentifier(entry))
        .filter((entry) => Number.isFinite(recoveryTimestamp(entry)));
      const newestByThreadId = new Map();
      for (const entry of recoverable) {
        const threadId = String(entry.threadId ?? entry.codexSessionId ?? '').trim();
        const current = newestByThreadId.get(threadId);
        if (!current || compareRecoveryRecency(entry, current) > 0) {
          newestByThreadId.set(threadId, entry);
        }
      }
      return [...newestByThreadId.values()].map((entry) => restoreRun(entry));
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
      .filter((run) => isRecoverableRunIdentifier(run))
      .filter((run) => hasValidOrMissingRecoveryTimestamp(run))
      .map((run) => snapshotRun(run));
    const directory = path.dirname(this.filePath);
    try {
      this.fs.mkdirSync(directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      this.fs.writeFileSync(temporary, JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        journalId: this.journalId,
        epoch: this.epoch,
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
    lastKnownStatus: String(entry.status ?? 'running'),
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

function recoveryTimestamp(entry) {
  const updatedAt = Date.parse(String(entry?.updatedAt ?? ''));
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  return Date.parse(String(entry?.createdAt ?? ''));
}

function compareRecoveryRecency(left, right) {
  const updatedDifference = recoveryTimestamp(left) - recoveryTimestamp(right);
  if (updatedDifference !== 0) {
    return updatedDifference;
  }
  const createdDifference = Date.parse(String(left?.createdAt ?? ''))
    - Date.parse(String(right?.createdAt ?? ''));
  return Number.isFinite(createdDifference) && createdDifference !== 0
    ? createdDifference
    : 0;
}

function hasValidOrMissingRecoveryTimestamp(entry) {
  const updatedAt = String(entry?.updatedAt ?? '').trim();
  const createdAt = String(entry?.createdAt ?? '').trim();
  return (!updatedAt && !createdAt) || Number.isFinite(recoveryTimestamp(entry));
}

function nullableString(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

function normalizeDeliveryMode(value) {
  return String(value ?? '').trim() === 'desktop_fallback' ? 'desktop_fallback' : 'app_server';
}
