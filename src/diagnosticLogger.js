import fs from 'node:fs/promises';
import path from 'node:path';
import { createId } from './ids.js';
import { analyzeLogRun } from './logAnalyzer.js';

const SECRET_KEYS = /authorization|token|password|secret|apikey|api_key|keypassword|storepassword|private|cookie|set-cookie/i;

export class DiagnosticLogger {
  constructor(options = {}) {
    this.root = options.root ?? process.env.CODEX_BRIDGE_LOG_DIR ?? path.resolve(process.cwd(), 'logs');
    this.maxStringLength = options.maxStringLength ?? 4000;
    this.currentRunDir = path.join(this.root, 'current-run');
    this.ready = null;
    this.currentRun = null;
    this.analysisTimer = null;
    this.analysisPromise = null;
    this.writeChain = Promise.resolve();
  }

  async startRun(label = 'manual') {
    await this.writeChain.catch(() => {});
    const runId = createId('run');
    await fs.mkdir(this.root, { recursive: true });
    await this.archiveCurrentRun();
    await fs.mkdir(this.currentRunDir, { recursive: true });
    await this.clearManagedRunFiles();
    const meta = {
      runId,
      label,
      startedAt: new Date().toISOString(),
      pid: process.pid
    };
    this.currentRun = meta;
    await fs.writeFile(path.join(this.currentRunDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    this.ready = Promise.resolve();
    await this.write('bridge', 'info', 'log.run.started', meta);
    await this.flushAnalysis();
    return meta;
  }

  async write(source, level, event, data = {}) {
    await this.ensureReady();
    const entry = {
      id: createId('log'),
      timestamp: new Date().toISOString(),
      source: sanitizeFilePart(source),
      level,
      event,
      data: this.redact(data)
    };
    const line = `${JSON.stringify(entry)}\n`;
    const writeTask = this.writeChain.catch(() => {}).then(async () => {
      await fs.appendFile(path.join(this.currentRunDir, `${entry.source}.jsonl`), line, 'utf8');
      await fs.appendFile(path.join(this.currentRunDir, 'all.jsonl'), line, 'utf8');
    });
    this.writeChain = writeTask;
    await writeTask;
    this.scheduleAnalysis();
    return entry;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = fs.mkdir(this.currentRunDir, { recursive: true })
        .then(async () => {
          const metaPath = path.join(this.currentRunDir, 'meta.json');
          try {
            await fs.access(metaPath);
          } catch {
            const meta = {
              runId: createId('run'),
              label: 'auto',
              startedAt: new Date().toISOString(),
              pid: process.pid
            };
            this.currentRun = meta;
            await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
          }
        });
    }
    await this.ready;
  }

  redact(value, key = '') {
    if (SECRET_KEYS.test(key)) {
      return '[REDACTED]';
    }
    if (typeof value === 'string') {
      return truncate(value, this.maxStringLength);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    const redacted = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = this.redact(childValue, childKey);
    }
    return redacted;
  }

  async getCurrentRun() {
    await this.ensureReady();
    if (this.currentRun) {
      return this.currentRun;
    }
    try {
      this.currentRun = JSON.parse(await fs.readFile(path.join(this.currentRunDir, 'meta.json'), 'utf8'));
      return this.currentRun;
    } catch {
      return null;
    }
  }

  async archiveCurrentRun() {
    const metaPath = path.join(this.currentRunDir, 'meta.json');
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      const archiveRoot = path.join(this.root, 'archive');
      const safeStartedAt = String(meta.startedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
      const safeRunId = sanitizeFilePart(meta.runId ?? 'run');
      const archiveDir = path.join(archiveRoot, `${safeStartedAt}_${safeRunId}`);
      await fs.mkdir(archiveRoot, { recursive: true });
      await fs.rm(archiveDir, { recursive: true, force: true });
      await fs.cp(this.currentRunDir, archiveDir, { recursive: true });
    } catch {
    }
  }

  async clearManagedRunFiles() {
    const items = await fs.readdir(this.currentRunDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(items.map(async (item) => {
      if (!item.isFile() || !isManagedRunFile(item.name)) {
        return;
      }
      await fs.rm(path.join(this.currentRunDir, item.name), { force: true }).catch(() => null);
    }));
  }

  scheduleAnalysis() {
    if (this.analysisTimer) {
      clearTimeout(this.analysisTimer);
    }
    this.analysisTimer = setTimeout(() => {
      this.analysisTimer = null;
      this.analysisPromise = analyzeLogRun(this.currentRunDir).catch(() => null);
    }, 500);
    this.analysisTimer.unref?.();
  }

  async flushAnalysis() {
    if (this.analysisTimer) {
      clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
    }
    this.analysisPromise = analyzeLogRun(this.currentRunDir).catch(() => null);
    return this.analysisPromise;
  }
}

function sanitizeFilePart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function isManagedRunFile(name) {
  return name === 'all.jsonl' ||
    name === 'meta.json' ||
    name === 'summary.json' ||
    name === 'summary.md' ||
    name.endsWith('.jsonl');
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}
