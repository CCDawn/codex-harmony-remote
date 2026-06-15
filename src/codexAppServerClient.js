import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin = options.codexBin ?? process.env.CODEX_BRIDGE_CODEX_BIN ?? resolveCodexBin();
    this.requestTimeoutMs = options.requestTimeoutMs ?? Number.parseInt(process.env.CODEX_APP_SERVER_TIMEOUT_MS ?? '30000', 10);
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextRequestId = 1;
    this.initialized = null;
    this.closed = false;
  }

  async request(method, params = {}) {
    await this.ensureStarted();
    const id = this.nextRequestId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.writeJson(message);
    });
  }

  async notify(method, params = {}) {
    await this.ensureStarted();
    this.writeJson(Object.keys(params).length > 0 ? { method, params } : { method });
  }

  async close() {
    this.closed = true;
    if (this.child) {
      this.child.kill();
    }
  }

  async ensureStarted() {
    if (!this.initialized) {
      this.initialized = this.start();
    }
    return this.initialized;
  }

  async start() {
    this.child = spawn(this.codexBin, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (exitCode) => {
      if (!this.closed) {
        this.rejectAll(new Error(`Codex app-server exited with code ${exitCode}`));
      }
    });

    const response = await this.requestRaw('initialize', {
      clientInfo: {
        name: 'codex-hramony',
        title: 'Codex Harmony Remote',
        version: '0.1.0'
      },
      capabilities: null
    });
    this.writeJson({ method: 'initialized' });
    return response;
  }

  requestRaw(method, params) {
    const id = this.nextRequestId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.writeJson(message);
    });
  }

  writeJson(message) {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const message = parseJsonLine(line);
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.resolveResponse(message);
      } else if (message?.method) {
        this.emit('notification', message);
      } else {
        this.emit('message', message);
      }
    }
  }

  resolveResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emit('orphanResponse', message);
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex app-server request failed: ${pending.method}`));
      return;
    }
    pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function resolveCodexBin() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const exePath = path.join(binRoot, entry.name, 'codex.exe');
      if (!fs.existsSync(exePath)) {
        continue;
      }
      const stat = fs.statSync(exePath);
      candidates.push({ exePath, mtimeMs: stat.mtimeMs });
    }
  } catch {
    // Keep the bridge usable on machines where Codex is resolved from PATH.
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.exePath ?? 'codex';
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return {
      method: 'raw',
      params: { line }
    };
  }
}
