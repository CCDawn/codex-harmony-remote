import http from 'node:http';
import { buildDesktopCdpWebSocketOptions } from '../src/codexDesktopCdpClient.js';

const cdpPort = Number.parseInt(process.argv[2] ?? '9229', 10);

async function main() {
  const targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const summaries = [];

  for (const target of targets) {
    if (!target.webSocketDebuggerUrl) {
      continue;
    }
    let client = null;
    try {
      client = await withTimeout(CdpClient.connect(target.webSocketDebuggerUrl), 3000, `connect ${target.id}`);
      await withTimeout(client.call('Runtime.enable'), 3000, `Runtime.enable ${target.id}`);
      const expression = target.type === 'page' ? pageProbeExpression() : workerProbeExpression();
      const result = await withTimeout(client.evaluate(expression), 3000, `evaluate ${target.id}`);
      summaries.push({
        id: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
        result
      });
    } catch (error) {
      summaries.push({
        id: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
        error: error.message
      });
    } finally {
      client?.close();
    }
  }

  console.log(JSON.stringify(summaries, null, 2));
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`CDP timeout: ${label}`));
      }, timeoutMs);
    })
  ]);
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
    this.events = [];
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      } else {
        this.events.push(message);
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

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.error) {
      return { error: response.error.message };
    }
    if (response.result?.exceptionDetails) {
      return {
        exception: response.result.exceptionDetails.text,
        description: response.result.exceptionDetails.exception?.description
      };
    }
    return response.result?.result?.value ?? null;
  }

  close() {
    this.socket.close();
  }
}

function pageProbeExpression() {
  return String.raw`
(() => {
  const eb = window.electronBridge;
  const sharedKeys = [
    'threads',
    'app-server',
    'appServer',
    'remoteControl',
    'hosts',
    'workspaces',
    'thread-list',
    'codex',
    'workers',
    'app-session',
    'worker-ids',
    'views'
  ];
  const shared = {};
  for (const key of sharedKeys) {
    try {
      const value = eb?.getSharedObjectSnapshotValue?.(key);
      shared[key] = summarize(value);
    } catch (error) {
      shared[key] = { error: String(error) };
    }
  }
  return {
    title: document.title,
    location: location.href,
    text: document.body?.innerText?.slice(0, 1200) ?? '',
    bridgeKeys: eb ? Object.keys(eb) : [],
    appSessionId: eb?.getAppSessionId?.() ?? null,
    buildFlavor: eb?.getBuildFlavor?.() ?? null,
    globalKeys: Object.keys(window).filter((key) => /codex|worker|thread|app/i.test(key)).slice(0, 80),
    shared
  };

  function summarize(value) {
    if (value == null) {
      return null;
    }
    if (typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return { kind: 'array', length: value.length, sample: value.slice(0, 3).map(summarize) };
    }
    const keys = Object.keys(value);
    return {
      kind: 'object',
      keys: keys.slice(0, 40),
      sample: Object.fromEntries(keys.slice(0, 8).map((key) => [key, summarize(value[key])]))
    };
  }
})()
`;
}

function workerProbeExpression() {
  return String.raw`
(() => {
  const keys = Object.keys(globalThis).filter((key) => /codex|worker|thread|app|server|client|port|ipc/i.test(key)).slice(0, 120);
  return {
    location: globalThis.location?.href ?? '',
    name: globalThis.name ?? '',
    keys,
    hasPostMessage: typeof globalThis.postMessage,
    hasOnMessage: typeof globalThis.onmessage,
    constructorNames: keys.slice(0, 20).map((key) => {
      try {
        const value = globalThis[key];
        return [key, value && value.constructor ? value.constructor.name : typeof value];
      } catch (error) {
        return [key, String(error)];
      }
    })
  };
})()
`;
}

await main();
