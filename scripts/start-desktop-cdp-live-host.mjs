import http from 'node:http';

const bridgeUrl = (process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
const cdpPort = Number.parseInt(process.env.CODEX_DESKTOP_CDP_PORT ?? '9229', 10);
const heartbeatMs = Number.parseInt(process.env.CODEX_DESKTOP_CDP_HEARTBEAT_MS ?? '3000', 10);
const drainMs = Number.parseInt(process.env.CODEX_DESKTOP_CDP_DRAIN_MS ?? '1000', 10);
const maxSoftFailures = Number.parseInt(process.env.CODEX_DESKTOP_CDP_SOFT_FAILURES ?? '3', 10);

const authHeaders = token ? { 'X-Codex-Bridge-Token': token } : {};

async function main() {
  let stopped = false;
  const state = {
    reconnectRequested: false,
    reconnectReason: null,
    lastStatus: null,
    consecutiveCdpFailures: 0
  };
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });

  while (!stopped) {
    state.reconnectRequested = false;
    state.reconnectReason = null;
    let client = null;
    try {
      const target = await waitForTarget();
      client = await CdpClient.connect(target.webSocketDebuggerUrl);
      await enableRuntimeIfAvailable(client);
      await installPageBridge(client);
      const status = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      state.lastStatus = status;
      state.consecutiveCdpFailures = 0;
      await post('/desktop/script/connect', status);
      console.log(JSON.stringify({ ok: true, status }, null, 2));

      const cycle = Promise.race([
        heartbeatLoop(client, () => stopped || state.reconnectRequested, state),
        drainLoop(client, () => stopped || state.reconnectRequested, state),
        pollLoop(client, () => stopped || state.reconnectRequested, state)
      ]);
      await cycle;
    } catch (error) {
      if (!stopped) {
        state.reconnectReason = state.reconnectReason || error;
        console.warn('[desktop-cdp-live-host] reconnecting:', state.reconnectReason.message);
      }
    } finally {
      client?.close();
    }

    if (!stopped && (state.reconnectRequested || state.reconnectReason)) {
      await sleep(1000);
    }
  }
}

async function enableRuntimeIfAvailable(client) {
  try {
    await client.call('Runtime.enable', {}, 3000);
  } catch (error) {
    console.warn('[desktop-cdp-live-host] Runtime.enable skipped:', error.message);
  }
}

function requestReconnect(state, error) {
  if (error) {
    state.reconnectReason = state.reconnectReason || error;
  }
  state.reconnectRequested = true;
}

function noteLoopSuccess(state) {
  state.consecutiveCdpFailures = 0;
}

function handleLoopFailure(state, label, error) {
  state.consecutiveCdpFailures += 1;
  const failures = state.consecutiveCdpFailures;
  if (failures === 1 || failures % 5 === 0) {
    console.warn(`[desktop-cdp-live-host] ${label} failed (${failures}/${maxSoftFailures}):`, error.message);
  }
  if (failures >= maxSoftFailures) {
    requestReconnect(state, error);
    return true;
  }
  return false;
}

function loopBackoffMs(state) {
  return Math.min(5000, Math.max(500, state.consecutiveCdpFailures * 1000));
}

async function heartbeatLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const status = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      state.lastStatus = status;
      noteLoopSuccess(state);
      await post('/desktop/script/status', status);
    } catch (error) {
      if (handleLoopFailure(state, 'heartbeat', error)) return;
      await sleep(loopBackoffMs(state));
    }
    await sleep(heartbeatMs);
  }
}

async function drainLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const payload = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.drainMessages(10)');
      state.lastStatus = stripMessages(payload);
      noteLoopSuccess(state);
      if (payload?.messages?.length > 0) {
        await post('/desktop/script/messages', payload);
      }
    } catch (error) {
      if (handleLoopFailure(state, 'drain', error)) return;
      await sleep(loopBackoffMs(state));
    }
    await sleep(drainMs);
  }
}

async function pollLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const status = state.lastStatus
        ?? await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      const result = await post('/desktop/script/poll', status, 35000);
      const commands = Array.isArray(result.commands) ? result.commands : [];
      for (const command of commands) {
        const dispatched = await dispatchCommand(client, command);
        if (!dispatched) {
          const error = new Error('桌面 CDP host 派发命令失败');
          if (handleLoopFailure(state, 'dispatch', error)) return;
        }
      }
      noteLoopSuccess(state);
    } catch (error) {
      if (handleLoopFailure(state, 'poll', error)) return;
      await sleep(loopBackoffMs(state));
    }
  }
}

async function dispatchCommand(client, command) {
  const expression = `window.__codexHramonyDesktopCdpHost.dispatch(${JSON.stringify(command)})`;
  let result = null;
  try {
    result = await evaluatePage(client, expression);
  } catch (error) {
    await postCommandError(command, error instanceof Error ? error.message : String(error));
    return false;
  }
  if (!result?.ok) {
    const errorMessage = result?.error ?? '桌面 CDP host 派发命令失败';
    await postCommandError(command, errorMessage, result);
    return false;
  }
  return true;
}

async function postCommandError(command, errorMessage, result = null) {
  await post('/desktop/script/messages', {
    scriptId: result?.scriptId ?? `desktop-cdp-host-${Date.now()}`,
    currentSessionId: result?.currentSessionId ?? null,
    messages: [buildCommandErrorMessage(command, errorMessage)]
  });
}

function stripMessages(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const { messages, ...status } = payload;
  return status;
}

function buildCommandErrorMessage(command, errorMessage) {
  if (command?.type === 'fetch') {
    return {
      type: 'fetch-response',
      requestId: command.requestId,
      hostId: command.hostId,
      responseType: 'error',
      error: errorMessage
    };
  }
  return {
    type: 'mcp-response',
    requestId: command?.requestId,
    hostId: command?.hostId,
    message: command?.request ? {
      id: command.request.id,
      error: { code: 1, message: errorMessage }
    } : undefined,
    responseType: 'error',
    error: errorMessage
  };
}

async function installPageBridge(client) {
  const source = `
(() => {
  if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== 'function') {
    throw new Error('当前页面不是 Codex 桌面窗口，找不到 electronBridge.sendMessageFromView');
  }
  if (window.__codexHramonyDesktopCdpHost?.stop) {
    window.__codexHramonyDesktopCdpHost.stop();
  }
  const state = {
    stopped: false,
    scriptId: 'desktop-cdp-host-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    queue: []
  };
  function extractConversationId(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const normalized = value.startsWith('#') ? value.slice(1) : value;
    const withoutQuery = normalized.split('?')[0].split('#')[0].replace(/\\/+$/, '');
    const match = withoutQuery.match(/^\\/(?:local|remote)\\/([^/]+)$/)
      || withoutQuery.match(/^\\/hotkey-window\\/thread\\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function currentSessionId() {
    return extractConversationId(window.location.pathname)
      || extractConversationId(window.location.hash)
      || extractConversationId(new URL(window.location.href).pathname)
      || null;
  }
  function status(extra = {}) {
    return { scriptId: state.scriptId, currentSessionId: currentSessionId(), ...extra };
  }
  function onDesktopMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mcp-response' || data.type === 'mcp-notification' || data.type === 'fetch-response') {
      state.queue.push(data);
      if (state.queue.length > 1000) state.queue.splice(0, state.queue.length - 1000);
    }
  }
  window.addEventListener('message', onDesktopMessage);
  window.__codexHramonyDesktopCdpHost = {
    stop() {
      state.stopped = true;
      window.removeEventListener('message', onDesktopMessage);
    },
    status() {
      return status({ stopped: state.stopped });
    },
    drainMessages(limit = 10) {
      const count = Math.max(1, Math.min(20, Number(limit) || 10));
      const messages = state.queue.splice(0, count);
      return status({ messages });
    },
    async dispatch(command) {
      try {
        await window.electronBridge.sendMessageFromView(command);
        return status({ ok: true });
      } catch (error) {
        return status({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return window.__codexHramonyDesktopCdpHost.status();
})()
`;
  await client.call('Page.addScriptToEvaluateOnNewDocument', { source });
  return evaluatePage(client, source);
}

async function evaluatePage(client, expression, timeoutMs = 15000) {
  const response = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  }, timeoutMs);
  if (response.error) {
    throw new Error(response.error.message ?? 'CDP evaluate failed');
  }
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  }
  return response.result?.result?.value ?? null;
}

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await getCdpTargets(cdpPort);
      const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      const page = pages.find((target) => target.title === 'Codex')
        ?? pages.find((target) => /codex/i.test(`${target.title ?? ''} ${target.url ?? ''}`))
        ?? pages[0];
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(700);
  }
  throw lastError ?? new Error(`No Codex CDP target found on 127.0.0.1:${cdpPort}`);
}

async function getCdpTargets(port) {
  for (const url of [`http://127.0.0.1:${port}/json`, `http://127.0.0.1:${port}/json/list`]) {
    try {
      const targets = await getJson(url);
      if (Array.isArray(targets)) return targets;
    } catch {
      // Try the next endpoint.
    }
  }
  throw new Error(`CDP target response is not available on 127.0.0.1:${port}`);
}

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out: ${url}`)));
    request.on('error', reject);
  });
}

async function post(path, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bridgeUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(json.error || text || `HTTP ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    };
    this.socket.onclose = () => this.rejectAll(new Error('CDP socket closed'));
    this.socket.onerror = () => this.rejectAll(new Error('CDP socket error'));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Failed to connect CDP websocket'));
    });
    return new CdpClient(socket);
  }

  call(method, params = {}, timeoutMs = 10000) {
    const queued = this.queue.then(
      () => this.callNow(method, params, timeoutMs),
      () => this.callNow(method, params, timeoutMs)
    );
    this.queue = queued.catch(() => {});
    return queued;
  }

  callNow(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

await main();
