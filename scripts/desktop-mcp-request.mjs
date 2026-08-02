import http from 'node:http';
import {
  buildDesktopCdpWebSocketOptions,
  selectCodexDesktopCdpTarget
} from '../src/codexDesktopCdpClient.js';

const cdpPort = Number.parseInt(process.env.CODEX_DESKTOP_CDP_PORT ?? '9229', 10);
const hostId = process.env.CODEX_DESKTOP_HOST_ID ?? 'local';
const method = process.argv[2] ?? 'thread/list';
const params = parseParams(process.argv[3]);
const requestId = `codex-hramony-${Date.now()}`;

async function main() {
  const page = selectCodexDesktopCdpTarget(
    await getJson(`http://127.0.0.1:${cdpPort}/json/list`)
  );

  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`Codex desktop page not found on CDP port ${cdpPort}`);
  }

  const client = await CdpClient.connect(page.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable');
    const result = await client.evaluate(buildExpression({ hostId, requestId, method, params }), 10000);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.close();
  }
}

function parseParams(value) {
  if (!value) {
    return {};
  }
  if (value.startsWith('base64:')) {
    return JSON.parse(Buffer.from(value.slice('base64:'.length), 'base64').toString('utf8'));
  }
  return JSON.parse(value);
}

function buildExpression({ hostId, requestId, method, params }) {
  return `
(() => new Promise((resolve) => {
  const hostId = ${JSON.stringify(hostId)};
  const request = {
    id: ${JSON.stringify(requestId)},
    method: ${JSON.stringify(method)},
    params: ${JSON.stringify(params)}
  };
  const timeout = setTimeout(() => {
    cleanup();
    resolve({ ok: false, error: 'timeout', request });
  }, 8000);
  const handler = (event) => {
    const data = event.data;
    if (!data || data.type !== 'mcp-response' || data.hostId !== hostId || data.message?.id !== request.id) {
      return;
    }
    cleanup();
    resolve({ ok: !data.message.error, response: data.message, request });
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
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
    }).on('error', reject);
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url, [], buildDesktopCdpWebSocketOptions(cdpPort));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
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
      this.pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    if (response.result?.exceptionDetails) {
      return {
        ok: false,
        error: response.result.exceptionDetails.text,
        description: response.result.exceptionDetails.exception?.description
      };
    }
    return response.result?.result?.value ?? null;
  }

  close() {
    this.socket.close();
  }
}

await main();
