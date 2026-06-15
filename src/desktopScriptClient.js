export function buildDesktopScriptClient({
  bridgeUrl,
  token = '',
  pollTimeoutMs = 25000,
  heartbeatMs = 5000
} = {}) {
  const baseUrl = String(bridgeUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('bridgeUrl is required');
  }
  const authHeader = token ? { 'X-Codex-Bridge-Token': token } : {};

  return `(() => {
  const bridgeUrl = ${JSON.stringify(baseUrl)};
  const authHeader = ${JSON.stringify(authHeader)};
  const pollTimeoutMs = ${JSON.stringify(pollTimeoutMs)};
  const heartbeatMs = ${JSON.stringify(heartbeatMs)};
  if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== 'function') {
    throw new Error('当前页面不是 Codex 桌面窗口，找不到 electronBridge.sendMessageFromView');
  }
  if (window.__codexHramonyDesktopScript?.stop) {
    window.__codexHramonyDesktopScript.stop();
  }

  const state = {
    stopped: false,
    scriptId: 'desktop-script-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    lastSessionId: null
  };

  function extractConversationId(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
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

  async function post(path, body) {
    const response = await fetch(bridgeUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(json.error || text || ('HTTP ' + response.status));
    }
    return json;
  }

  function envelope(extra = {}) {
    state.lastSessionId = currentSessionId();
    return {
      scriptId: state.scriptId,
      currentSessionId: state.lastSessionId,
      ...extra
    };
  }

  function sendMessages(messages) {
    if (!messages.length || state.stopped) {
      return Promise.resolve();
    }
    return post('/desktop/script/messages', envelope({ messages })).catch((error) => {
      console.warn('[codex-hramony] 上传桌面事件失败', error);
    });
  }

  function onDesktopMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.type === 'mcp-response' || data.type === 'mcp-notification' || data.type === 'fetch-response') {
      sendMessages([data]);
    }
  }

  async function handleCommand(command) {
    if (!command || typeof command !== 'object') {
      return;
    }
    await window.electronBridge.sendMessageFromView(command);
  }

  async function heartbeatLoop() {
    while (!state.stopped) {
      try {
        await post('/desktop/script/status', envelope());
      } catch (error) {
        console.warn('[codex-hramony] 桌面脚本桥心跳失败', error);
      }
      await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
    }
  }

  async function pollLoop() {
    while (!state.stopped) {
      try {
        const result = await post('/desktop/script/poll', envelope());
        const commands = Array.isArray(result.commands) ? result.commands : [];
        for (const command of commands) {
          if (state.stopped) {
            return;
          }
          handleCommand(command).catch((error) => {
            sendMessages([{
              type: command.type === 'fetch' ? 'fetch-response' : 'mcp-response',
              requestId: command.requestId,
              hostId: command.hostId,
              message: command.request ? {
                id: command.request.id,
                error: { code: 1, message: error instanceof Error ? error.message : String(error) }
              } : undefined,
              responseType: 'error',
              error: error instanceof Error ? error.message : String(error)
            }]);
          });
        }
      } catch (error) {
        console.warn('[codex-hramony] 桌面脚本桥轮询失败', error);
        await new Promise((resolve) => setTimeout(resolve, Math.min(heartbeatMs, pollTimeoutMs)));
      }
    }
  }

  window.addEventListener('message', onDesktopMessage);
  window.__codexHramonyDesktopScript = {
    scriptId: state.scriptId,
    stop() {
      state.stopped = true;
      window.removeEventListener('message', onDesktopMessage);
    },
    status() {
      return {
        scriptId: state.scriptId,
        currentSessionId: currentSessionId(),
        bridgeUrl,
        stopped: state.stopped
      };
    }
  };

  post('/desktop/script/connect', envelope())
    .then(() => console.log('[codex-hramony] 桌面脚本桥已连接', window.__codexHramonyDesktopScript.status()))
    .catch((error) => console.warn('[codex-hramony] 桌面脚本桥连接失败', error));
  heartbeatLoop();
  pollLoop();
  return window.__codexHramonyDesktopScript;
})()`;
}
