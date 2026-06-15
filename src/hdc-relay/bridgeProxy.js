import net from 'node:net';
import { pipeBoth, readJsonLine, writeJsonLine } from './framing.js';

export function createBridgeProxy({
  relayHost,
  relayPort = 19078,
  token = '',
  localBridgeHost = '127.0.0.1',
  localBridgePort = 8787,
  poolSize = 4,
  reconnectMs = 1000,
  waitingSocketTtlMs = 30000
} = {}) {
  if (!relayHost) {
    throw new Error('relayHost is required');
  }

  const sockets = new Set();
  let stopped = false;

  function start() {
    for (let i = 0; i < poolSize; i += 1) {
      connectSlot(i);
    }
  }

  function connectSlot(slot) {
    if (stopped) {
      return;
    }

    let paired = false;
    const relaySocket = net.createConnection({ host: relayHost, port: relayPort });
    relaySocket.setNoDelay(true);
    relaySocket.setKeepAlive(true, 15000);
    sockets.add(relaySocket);

    const waitingTimer = setTimeout(() => {
      if (!paired && !relaySocket.destroyed) {
        relaySocket.destroy();
      }
    }, waitingSocketTtlMs);

    relaySocket.on('connect', () => {
      writeJsonLine(relaySocket, {
        role: 'bridge-pc',
        token
      });
    });

    relaySocket.on('error', () => {});
    relaySocket.on('close', () => {
      clearTimeout(waitingTimer);
      sockets.delete(relaySocket);
      if (!stopped && !paired) {
        setTimeout(() => connectSlot(slot), reconnectMs);
      }
    });

    void waitForPaired(relaySocket)
      .then(({ hello, rest }) => {
        if (!hello.ok) {
          relaySocket.destroy();
          return;
        }
        if (hello.mode !== 'paired') {
          return;
        }
        paired = true;
        clearTimeout(waitingTimer);
        setTimeout(() => connectSlot(slot), 0);
        const bridgeSocket = net.createConnection({ host: localBridgeHost, port: localBridgePort });
        bridgeSocket.setNoDelay(true);
        bridgeSocket.on('connect', () => {
          pipeBoth(relaySocket, bridgeSocket, rest);
        });
        bridgeSocket.on('error', () => relaySocket.destroy());
      })
      .catch(() => {
        relaySocket.destroy();
      });
  }

  async function waitForPaired(socket) {
    while (true) {
      const parsed = await readJsonLine(socket, { timeoutMs: 0 });
      if (!parsed.hello.ok || parsed.hello.mode === 'paired') {
        return parsed;
      }
    }
  }

  async function close() {
    stopped = true;
    for (const socket of sockets) {
      socket.destroy();
    }
  }

  return { start, close };
}
