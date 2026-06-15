import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_REASONING_EFFORTS = new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export class SessionSettingsStore {
  constructor(options = {}) {
    this.filePath = options.filePath ?? path.join(options.repoRoot ?? process.cwd(), 'logs', 'session-settings.json');
    this.cache = null;
    this.writeQueue = Promise.resolve();
  }

  async getSessionSettings(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const data = await this.readData();
    const settings = data.sessions[normalizedSessionId] ?? {};
    return normalizeSessionSettings(settings);
  }

  async updateSessionSettings(sessionId, patch = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const data = await this.readData();
    const current = normalizeSessionSettings(data.sessions[normalizedSessionId] ?? {});
    const next = {
      ...current,
      updatedAt: new Date().toISOString()
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) {
      next.reasoningEffort = normalizeReasoningEffort(patch.reasoningEffort);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
      next.model = normalizeModelId(patch.model);
    }
    data.sessions[normalizedSessionId] = next;
    await this.writeData(data);
    return normalizeSessionSettings(next);
  }

  async deleteSessionSettings(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const data = await this.readData();
    delete data.sessions[normalizedSessionId];
    await this.writeData(data);
  }

  async readData() {
    if (this.cache) {
      return this.cache;
    }
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      this.cache = {
        version: 1,
        sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {}
      };
    } catch {
      this.cache = { version: 1, sessions: {} };
    }
    return this.cache;
  }

  async writeData(data) {
    this.cache = data;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    });
    return this.writeQueue;
  }
}

export function normalizeSessionSettings(settings = {}) {
  return {
    model: normalizeModelId(settings.model),
    reasoningEffort: normalizeReasoningEffort(settings.reasoningEffort),
    updatedAt: String(settings.updatedAt ?? '')
  };
}

export function normalizeModelId(value) {
  const text = String(value ?? '').trim();
  const normalized = ['auto', 'default', 'none', 'null'].includes(text.toLowerCase()) ? '' : text;
  if (normalized.length === 0) {
    return '';
  }
  if (normalized.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(normalized)) {
    const error = new Error('Invalid model');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const normalized = text === 'auto' || text === 'default' || text === 'none' || text === 'null'
    ? ''
    : text;
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    const error = new Error('Invalid reasoning effort');
    error.statusCode = 400;
    error.allowedValues = [...VALID_REASONING_EFFORTS];
    throw error;
  }
  return normalized;
}

function normalizeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
  return text;
}
