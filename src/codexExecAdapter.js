import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class CodexExecAdapter {
  constructor(options = {}) {
    this.codexBin = options.codexBin ?? process.env.CODEX_BRIDGE_CODEX_BIN ?? 'codex';
    this.model = options.model ?? process.env.CODEX_BRIDGE_MODEL ?? '';
    this.sandbox = options.sandbox ?? process.env.CODEX_BRIDGE_SANDBOX ?? 'danger-full-access';
    this.approvalPolicy = options.approvalPolicy ?? process.env.CODEX_BRIDGE_APPROVAL_POLICY ?? 'never';
    this.timeoutMs = Number.parseInt(process.env.CODEX_BRIDGE_CODEX_TIMEOUT_MS ?? '900000', 10);
  }

  async run({ task, project, emit }) {
    const outputPath = path.join(os.tmpdir(), `${task.id}-codex-last-message.txt`);
    const args = task.codexSessionId
      ? this.buildResumeArgs({ outputPath, sessionId: task.codexSessionId, task })
      : this.buildExecArgs({ outputPath, project, task });
    const desktopSync = createDesktopSyncStatus(task);

    emit('codex.exec.started', {
      command: `${this.codexBin} ${args.map(quoteArg).join(' ')}`,
      cwd: project.root,
      sandbox: this.sandbox,
      approvalPolicy: this.approvalPolicy,
      mode: task.codexSessionId ? 'resume' : 'new',
      codexSessionId: task.codexSessionId ?? null
    });
    emit('codex.desktop_sync', desktopSync);

    const child = spawn(this.codexBin, args, {
      cwd: project.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });
    child.stdin.end(task.prompt, 'utf8');

    let stdoutBuffer = '';
    let stderrText = '';
    const finalMessages = [];

    const timeout = setTimeout(() => {
      emit('codex.exec.timeout', { timeoutMs: this.timeoutMs });
      child.kill();
    }, this.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        const parsed = sanitizeEvent(parseJsonLine(line));
        emit('codex.exec.event', parsed);
        collectFinalMessages(parsed, finalMessages);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrText += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          emit('codex.exec.stderr', { line });
        }
      }
    });

    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timeout);

    if (stdoutBuffer.trim().length > 0) {
      const parsed = sanitizeEvent(parseJsonLine(stdoutBuffer));
      emit('codex.exec.event', parsed);
      collectFinalMessages(parsed, finalMessages);
    }

    emit('codex.exec.finished', {
      exitCode,
      stderr: tail(stderrText, 4000)
    });

    if (exitCode !== 0) {
      throw new Error(`Codex exec failed with exit code ${exitCode}: ${tail(stderrText, 1000)}`);
    }

    const lastMessage = await readLastMessage(outputPath);

    return {
      summary: lastMessage || finalMessages.at(-1) || 'Codex exec completed',
      changedFiles: [],
      tests: [],
      exitCode,
      desktopSync
    };
  }

  buildExecArgs({ outputPath, project, task = {} }) {
    const args = [
      'exec',
      '--json',
      '--output-last-message',
      outputPath,
      '--cd',
      project.root,
      '--sandbox',
      this.sandbox,
      '-c',
      `approval_policy="${this.approvalPolicy}"`,
      '--skip-git-repo-check'
    ];

    this.appendModel(args, task);
    args.push('-');
    return args;
  }

  buildResumeArgs({ outputPath, sessionId, task = {} }) {
    const args = [
      'exec',
      'resume',
      '--json',
      '--output-last-message',
      outputPath,
      '-c',
      `approval_policy="${this.approvalPolicy}"`,
      '--skip-git-repo-check'
    ];

    this.appendModel(args, task);
    args.push(sessionId, '-');
    return args;
  }

  appendModel(args, task = {}) {
    const requested = String(task?.model ?? '').trim();
    const model = requested.length > 0 ? requested : this.model.trim();
    if (model.length > 0) {
      args.push('--model', model);
    }
  }
}

function createDesktopSyncStatus(task) {
  const mode = task.codexSessionId ? 'resume' : 'new';
  return {
    status: 'file_only',
    desktopLive: false,
    mode,
    message: '已写入 Codex 本地会话文件；当前 Codex 桌面窗口不会自动实时刷新这条外部写入，请在桌面重新打开或刷新该会话查看。',
    reason: '手机端当前通过独立的 codex exec 进程提交消息，桌面窗口只订阅自己 app-server 的实时事件。'
  };
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object') {
    return event;
  }
  if (event.item && typeof event.item === 'object') {
    event.item = sanitizeObject(event.item);
  }
  return sanitizeObject(event);
}

function sanitizeObject(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (typeof copy[key] === 'string') {
      copy[key] = truncate(copy[key], 3000);
    } else if (copy[key] && typeof copy[key] === 'object') {
      copy[key] = sanitizeObject(copy[key]);
    }
  }
  return copy;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return {
      type: 'raw',
      line
    };
  }
}

function collectFinalMessages(event, finalMessages) {
  const message = extractMessageText(event);
  if (message.length > 0) {
    finalMessages.push(message);
  }
}

function extractMessageText(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }
  if (typeof event.message === 'string') {
    return event.message;
  }
  if (typeof event.text === 'string') {
    return event.text;
  }
  if (event.type === 'agent_message' && typeof event.data?.message === 'string') {
    return event.data.message;
  }
  if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
    return event.item.text;
  }
  if (event.type === 'message' && typeof event.data?.text === 'string') {
    return event.data.text;
  }
  return '';
}

function quoteArg(value) {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function tail(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

async function readLastMessage(outputPath) {
  try {
    return (await fs.readFile(outputPath, 'utf8')).trim();
  } catch {
    return '';
  } finally {
    try {
      await fs.unlink(outputPath);
    } catch {
    }
  }
}
