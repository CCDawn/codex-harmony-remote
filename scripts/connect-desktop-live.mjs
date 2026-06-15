import http from 'node:http';

const bridgeUrl = (process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
const cdpPort = Number.parseInt(process.env.CODEX_DESKTOP_CDP_PORT ?? '9229', 10);

async function main() {
  const script = await fetchDesktopScript();
  const target = await findCodexCdpTarget().catch((error) => {
    return { error };
  });

  if (!target || target.error || !target.webSocketDebuggerUrl) {
    printManualInstructions(target?.error);
    return;
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable');
    const bootstrapExpression = `(0, eval)(${JSON.stringify(script)})`;
    await client.call('Page.addScriptToEvaluateOnNewDocument', {
      source: bootstrapExpression
    });
    const expression = `
(() => {
  ${bootstrapExpression};
  return window.__codexHramonyDesktopScript.status();
})()
`;
    const status = await client.evaluate(expression, 15000);
    console.log(JSON.stringify({
      ok: true,
      injected: true,
      status
    }, null, 2));
  } finally {
    client.close();
  }
}

async function fetchDesktopScript() {
  const headers = token ? { 'X-Codex-Bridge-Token': token } : {};
  const response = await fetch(`${bridgeUrl}/desktop/script/client.js`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to load desktop script client: HTTP ${response.status}`);
  }
  return response.text();
}

async function findCodexCdpTarget() {
  const targets = await getCdpTargets(cdpPort);
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  return pages.find((target) => target.title === 'Codex')
    ?? pages.find((target) => /codex/i.test(`${target.title ?? ''} ${target.url ?? ''}`))
    ?? pages[0];
}

function printManualInstructions(error) {
  const snippet = `fetch(${JSON.stringify(`${bridgeUrl}/desktop/script/client.js`)}, { headers: ${JSON.stringify(token ? { 'X-Codex-Bridge-Token': token } : {})} }).then(r => r.text()).then(code => (0, eval)(code))`;
  console.log(JSON.stringify({
    ok: false,
    injected: false,
    reason: error?.message ?? `No Codex CDP target found on 127.0.0.1:${cdpPort}`,
    nextStep: 'Codex 桌面没有开放 CDP。请用 npm run desktop:live:start 通过本项目自己的启动器重启 Codex 并自动注入；DevTools Console 只作为最后兜底。',
    manualConsoleSnippet: snippet
  }, null, 2));
}

async function getCdpTargets(port) {
  const urls = [
    `http://127.0.0.1:${port}/json`,
    `http://127.0.0.1:${port}/json/list`
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const targets = await getJson(url);
      if (Array.isArray(targets)) {
        return targets;
      }
      throw new Error(`CDP target response is not an array: ${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No Codex CDP target found on 127.0.0.1:${port}`);
}

function getJson(url, timeoutMs = 5000) {
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
      request.destroy(new Error(`CDP request timed out: ${url}`));
    });
    request.on('error', reject);
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
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

  async evaluate(expression, timeoutMs = 10000) {
    const response = await this.call('Runtime.evaluate', {
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
