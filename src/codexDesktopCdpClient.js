import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class CodexDesktopCdpClient {
  constructor(options = {}) {
    this.configuredPort = options.port ?? null;
    this.port = this.configuredPort ?? resolveDesktopCdpPort();
    this.hostId = options.hostId ?? process.env.CODEX_DESKTOP_HOST_ID ?? 'local';
    this.timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.CODEX_DESKTOP_CDP_TIMEOUT_MS ?? '30000', 10);
    this.socket = null;
    this.pending = new Map();
    this.nextCdpId = 1;
    this.nextMcpId = 1;
    this.connected = null;
    this.notificationOffset = 0;
  }

  async request(method, params = {}) {
    const operation = async () => {
      await this.ensureConnected();
      const request = {
        id: `desktop-cdp-${Date.now()}-${this.nextMcpId++}`,
        method,
        params
      };
      return this.evaluate(requestExpression(this.hostId, request), this.timeoutMs);
    };
    return this.withCdpReconnectRetry(operation, {
      retries: isRetryableDesktopMethod(method) ? 1 : 0
    });
  }

  async fetchFromHost(command, params = {}) {
    const operation = async () => {
      await this.ensureConnected();
      return this.evaluate(hostFetchExpression(command, params), this.timeoutMs);
    };
    return this.withCdpReconnectRetry(operation, { retries: isRetryableHostCommand(command) ? 1 : 0 });
  }

  async fetchAuthenticatedPath(urlPath, options = {}) {
    const operation = async () => {
      await this.ensureConnected();
      const result = await this.evaluate(authenticatedPathFetchExpression(urlPath, options), options.timeoutMs ?? this.timeoutMs);
      if (result?.requestOk !== true) {
        const statusText = result?.status ? `HTTP ${result.status}: ` : '';
        throw new Error(`${statusText}${result?.error ?? 'Codex 桌面已登录态请求失败'}`);
      }
      return result.body;
    };
    return this.withCdpReconnectRetry(operation, { retries: 1 });
  }

  async probe() {
    return this.request('thread/list', {
      limit: 1,
      useStateDbOnly: true,
      archived: false
    });
  }

  async getCurrentConversationId() {
    return this.withCdpReconnectRetry(async () => {
      await this.ensureConnected();
      return this.evaluate(currentConversationIdExpression(), this.timeoutMs);
    }, { retries: 1 });
  }

  async drainNotifications() {
    return this.withCdpReconnectRetry(async () => {
      await this.ensureConnected();
      const result = await this.evaluate(`
(() => {
  window.__codexHramonyBridge = window.__codexHramonyBridge || { notifications: [], installed: false };
  const bridge = window.__codexHramonyBridge;
  if (!bridge.installed) {
    bridge.installed = true;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'mcp-notification') {
        bridge.notifications.push({ at: Date.now(), hostId: data.hostId, method: data.method, params: data.params });
        if (bridge.notifications.length > 1000) {
          bridge.notifications.splice(0, bridge.notifications.length - 1000);
        }
      }
    });
  }
  return bridge.notifications;
})()
`, this.timeoutMs);
      const notifications = Array.isArray(result) ? result.slice(this.notificationOffset) : [];
      if (Array.isArray(result)) {
        this.notificationOffset = result.length;
      }
      return notifications.filter((notification) => notification.hostId === this.hostId);
    }, { retries: 1 });
  }

  async ensureConnected() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connected) {
      return this.connected;
    }
    if (this.socket) {
      this.closeSocket(this.socket);
      this.socket = null;
    }
    this.connected = this.connect().then(() => {
      this.connected = null;
    }).catch((error) => {
      this.connected = null;
      this.closeSocket(this.socket);
      this.socket = null;
      throw error;
    });
    return this.connected;
  }

  async connect() {
    const ports = this.configuredPort ? [this.configuredPort] : resolveDesktopCdpPortCandidates();
    let page = null;
    let lastError = null;
    for (const port of ports) {
      try {
        const targets = await getCdpTargets(port, Math.min(this.timeoutMs, 5000));
        page = targets.find((target) => target.type === 'page' && target.title === 'Codex' && target.webSocketDebuggerUrl)
          ?? targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && /codex/i.test(`${target.title ?? ''} ${target.url ?? ''}`))
          ?? targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          this.port = port;
          break;
        }
        lastError = new Error(`未找到 Codex 桌面窗口 CDP 入口：127.0.0.1:${port}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (!page?.webSocketDebuggerUrl) {
      throw lastError ?? new Error(`未找到 Codex 桌面窗口 CDP 入口：${ports.map((port) => `127.0.0.1:${port}`).join(', ')}`);
    }

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    this.socket = socket;
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onclose = () => this.markDisconnected(socket, new Error('Codex 桌面 CDP 连接已关闭'));
    socket.onerror = () => this.markDisconnected(socket, new Error('Codex 桌面 CDP 连接错误'));

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('连接 Codex 桌面 CDP 超时')), this.timeoutMs);
      socket.onopen = () => {
        clearTimeout(timeout);
        socket.onerror = () => this.markDisconnected(socket, new Error('Codex 桌面 CDP 连接错误'));
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        this.markDisconnected(socket, new Error('连接 Codex 桌面 CDP 失败'));
        reject(new Error('连接 Codex 桌面 CDP 失败'));
      };
    });
    await this.enableRuntimeIfAvailable();
    await this.installNotificationCollector();
  }

  refreshPort() {
    this.port = this.configuredPort ?? resolveDesktopCdpPortCandidates()[0] ?? 9229;
    return this.port;
  }

  async enableRuntimeIfAvailable() {
    try {
      await this.call('Runtime.enable', {}, Math.min(this.timeoutMs, 3000));
    } catch {
      // Some Codex/Electron builds accept Runtime.evaluate but stall Runtime.enable.
    }
  }

  async installNotificationCollector() {
    const result = await this.evaluate(`
(() => {
  window.__codexHramonyBridge = window.__codexHramonyBridge || { notifications: [], installed: false };
  const bridge = window.__codexHramonyBridge;
  if (!bridge.installed) {
    bridge.installed = true;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'mcp-notification') {
        bridge.notifications.push({ at: Date.now(), hostId: data.hostId, method: data.method, params: data.params });
        if (bridge.notifications.length > 1000) {
          bridge.notifications.splice(0, bridge.notifications.length - 1000);
        }
      }
    });
  }
  return bridge.notifications.length;
})()
`, this.timeoutMs);
    this.notificationOffset = Number.isFinite(Number(result)) ? Number(result) : 0;
  }

  async evaluate(expression, timeoutMs = this.timeoutMs) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    if (response.error) {
      throw new Error(response.error.message ?? 'Codex 桌面 CDP 调用失败');
    }
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
    }
    const value = response.result?.result?.value;
    if (value && value.ok === false) {
      throw new Error(value.error ?? value.response?.error?.message ?? 'Codex 桌面 app-server 请求失败');
    }
    return value?.response?.result ?? value;
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex 桌面 CDP 未连接');
    }
    const socket = this.socket;
    const id = this.nextCdpId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.markDisconnected(socket, new Error(`Codex 桌面 CDP 请求超时：${method}`));
        try {
          socket.close();
        } catch {
          // The socket may already be closed by Electron/CDP.
        }
        reject(new Error(`Codex 桌面 CDP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.markDisconnected(socket, error instanceof Error ? error : new Error(String(error)));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id || !this.pending.has(message.id)) {
      return;
    }
    const pending = this.pending.get(message.id);
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  close() {
    const socket = this.socket;
    this.rejectAll(new Error('Codex 桌面 CDP 连接已关闭'));
    this.socket = null;
    this.connected = null;
    this.closeSocket(socket);
  }

  markDisconnected(socket, error) {
    if (socket && this.socket !== socket) {
      return;
    }
    const socketToClose = socket ?? this.socket;
    this.rejectAll(error);
    this.socket = null;
    this.connected = null;
    this.closeSocket(socketToClose);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  closeSocket(socket) {
    if (!socket || typeof socket.close !== 'function') {
      return;
    }
    try {
      socket.close();
    } catch {
      // CDP sockets can already be closing when the error handler runs.
    }
  }

  async withCdpReconnectRetry(operation, options = {}) {
    const retries = Math.max(0, Number.parseInt(String(options.retries ?? 0), 10) || 0);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableCdpTransportError(error)) {
          throw error;
        }
        this.markDisconnected(this.socket, error instanceof Error ? error : new Error(String(error)));
        await sleep(100 * (attempt + 1));
      }
    }
    throw lastError ?? new Error('Codex 桌面 CDP 请求失败');
  }
}

function isRetryableDesktopMethod(method) {
  return new Set([
    'thread/list',
    'thread/read'
  ]).has(String(method));
}

function isRetryableHostCommand(command) {
  return /^load-/i.test(String(command));
}

export function isRetryableCdpTransportError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Codex 桌面 CDP (?:连接错误|连接已关闭|未连接|请求超时)|连接 Codex 桌面 CDP 失败/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractConversationIdFromPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const normalized = value.startsWith('#') ? value.slice(1) : value;
  const withoutQuery = normalized.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const match = withoutQuery.match(/^\/(?:local|remote)\/([^/]+)$/)
    ?? withoutQuery.match(/^\/hotkey-window\/thread\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function resolveDesktopCdpPort(env = process.env) {
  return resolveDesktopCdpPortCandidates(env)[0] ?? 9229;
}

export function resolveDesktopCdpPortCandidates(env = process.env) {
  const candidates = [];
  const addCandidate = (port) => {
    if (Number.isInteger(port) && port > 0 && !candidates.includes(port)) {
      candidates.push(port);
    }
  };

  const configured = Number.parseInt(env.CODEX_DESKTOP_CDP_PORT ?? '', 10);
  addCandidate(configured);

  try {
    const statusPath = env.CODEX_DESKTOP_CDP_STATUS_PATH
      ?? path.join(projectRoot, 'logs', 'desktop-live-status.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''));
    if (String(status?.status ?? '') !== 'injected') {
      addCandidate(9229);
      return candidates;
    }
    const statusPort = Number.parseInt(String(status?.cdpPort ?? ''), 10);
    const updatedAtMs = Date.parse(String(status?.updatedAt ?? ''));
    const maxAgeMs = Number.parseInt(env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS ?? '600000', 10);
    if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0) {
      if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > maxAgeMs) {
        addCandidate(statusPort);
        addCandidate(9229);
        return candidates;
      }
    }
    addCandidate(statusPort);
  } catch {
    // The live launcher has not written a status file yet.
  }

  addCandidate(9229);
  return candidates;
}

function currentConversationIdExpression() {
  return `
(() => {
  const extract = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    const normalized = value.startsWith('#') ? value.slice(1) : value;
    const withoutQuery = normalized.split('?')[0].split('#')[0].replace(/\\/+$/, '');
    const match = withoutQuery.match(/^\\/(?:local|remote)\\/([^/]+)$/)
      || withoutQuery.match(/^\\/hotkey-window\\/thread\\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  };
  return extract(window.location.pathname)
    || extract(window.location.hash)
    || extract(new URL(window.location.href).pathname)
    || null;
})()
`;
}

function requestExpression(hostId, request) {
  return `
(() => new Promise((resolve) => {
  window.__codexHramonyBridge = window.__codexHramonyBridge || { notifications: [], installed: false };
  const bridge = window.__codexHramonyBridge;
  if (!bridge.installed) {
    bridge.installed = true;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'mcp-notification') {
        bridge.notifications.push({ at: Date.now(), hostId: data.hostId, method: data.method, params: data.params });
        if (bridge.notifications.length > 1000) {
          bridge.notifications.splice(0, bridge.notifications.length - 1000);
        }
      }
    });
  }
  const hostId = ${JSON.stringify(hostId)};
  const request = ${JSON.stringify(request)};
  const timeout = setTimeout(() => {
    cleanup();
    resolve({ ok: false, error: '等待 Codex 桌面 app-server 响应超时', request });
  }, ${Math.max(1000, Number.parseInt(process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS ?? '30000', 10))});
  const handler = (event) => {
    const data = event.data;
    if (!data || data.type !== 'mcp-response' || data.hostId !== hostId || data.message?.id !== request.id) {
      return;
    }
    cleanup();
    resolve({ ok: !data.message.error, response: data.message, request, error: data.message.error?.message });
  };
  const cleanup = () => {
    clearTimeout(timeout);
    window.removeEventListener('message', handler);
  };
  window.addEventListener('message', handler);
  window.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId, request }).catch((error) => {
    cleanup();
    resolve({ ok: false, error: String(error), request });
  });
}))()
`;
}

function hostFetchExpression(command, params) {
  return `
(() => new Promise((resolve) => {
  const requestId = 'desktop-host-fetch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const timeout = setTimeout(() => {
    cleanup();
    resolve({ ok: false, error: '等待 Codex 桌面 Host 命令响应超时', command, requestId });
  }, ${Math.max(1000, Number.parseInt(process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS ?? '30000', 10))});
  const handler = (event) => {
    const data = event.data;
    if (!data || data.type !== 'fetch-response' || data.requestId !== requestId) {
      return;
    }
    cleanup();
    if (data.responseType === 'success') {
      try {
        resolve({ ok: true, response: { result: JSON.parse(data.bodyJsonString) }, status: data.status, requestId });
      } catch (error) {
        resolve({ ok: false, error: String(error), status: data.status, requestId });
      }
      return;
    }
    resolve({ ok: false, error: data.error || data.bodyJsonString || 'Codex 桌面 Host 命令失败', status: data.status, requestId });
  };
  const cleanup = () => {
    clearTimeout(timeout);
    window.removeEventListener('message', handler);
  };
  const command = ${JSON.stringify(command)};
  const params = ${JSON.stringify(params)};
  window.addEventListener('message', handler);
  window.electronBridge.sendMessageFromView({
    type: 'fetch',
    requestId,
    method: 'POST',
    url: 'vscode://codex/' + command,
    body: JSON.stringify(params)
  }).catch((error) => {
    cleanup();
    resolve({ ok: false, error: String(error), command, requestId });
  });
}))()
`;
}

function authenticatedPathFetchExpression(urlPath, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = {
    'OAI-Language': String(options.language ?? 'zh-CN'),
    originator: 'Codex Desktop',
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {})
  };
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const timeoutMs = Math.max(1000, Number.parseInt(String(options.timeoutMs ?? process.env.CODEX_DESKTOP_FETCH_TIMEOUT_MS ?? '10000'), 10) || 10000);
  return `
(() => new Promise((resolve) => {
  if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== 'function') {
    resolve({ requestOk: false, error: 'Codex 桌面 fetch 通道不可用' });
    return;
  }
  const requestId = 'desktop-auth-fetch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const timeout = setTimeout(() => {
    cleanup();
    resolve({ requestOk: false, error: '等待 Codex 桌面用量接口响应超时', requestId });
  }, ${timeoutMs});
  const handler = (event) => {
    const data = event.data;
    if (!data || data.type !== 'fetch-response' || data.requestId !== requestId) {
      return;
    }
    cleanup();
    if (data.responseType === 'success') {
      let body = null;
      try {
        body = data.bodyJsonString ? JSON.parse(data.bodyJsonString) : null;
      } catch {
        resolve({ requestOk: false, status: data.status, error: 'Codex 桌面返回了非 JSON 数据', requestId });
        return;
      }
      if (Number(data.status) >= 200 && Number(data.status) < 300) {
        resolve({ requestOk: true, status: data.status, body, requestId });
        return;
      }
      resolve({
        requestOk: false,
        status: data.status,
        body,
        error: body?.error?.message || body?.message || data.bodyJsonString || 'Codex 用量接口返回错误',
        requestId
      });
      return;
    }
    resolve({
      requestOk: false,
      status: data.status,
      error: data.error || data.bodyJsonString || 'Codex 桌面 fetch 请求失败',
      requestId
    });
  };
  const cleanup = () => {
    clearTimeout(timeout);
    window.removeEventListener('message', handler);
  };
  window.addEventListener('message', handler);
  window.electronBridge.sendMessageFromView({
    type: 'fetch',
    requestId,
    method: ${JSON.stringify(method)},
    url: ${JSON.stringify(urlPath)},
    headers: ${JSON.stringify(headers)}${body === null ? '' : `,
    body: ${JSON.stringify(body)}`}
  }).catch((error) => {
    cleanup();
    resolve({ requestOk: false, error: String(error), requestId });
  });
}))()
`;
}

async function getCdpTargets(port, timeoutMs = 10000) {
  const urls = [
    `http://127.0.0.1:${port}/json`,
    `http://127.0.0.1:${port}/json/list`
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const targets = await getJson(url, timeoutMs);
      if (Array.isArray(targets)) {
        return targets;
      }
      throw new Error(`Codex 桌面 CDP 返回格式异常：${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`请求 Codex 桌面 CDP 入口失败：127.0.0.1:${port}`);
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求 Codex 桌面 CDP 入口超时：${url}`));
    });
    request.on('error', reject);
  });
}
