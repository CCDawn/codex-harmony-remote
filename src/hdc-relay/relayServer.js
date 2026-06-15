import net from 'node:net';
import { createChannelId, pipeBoth, readLine, writeJsonLine } from './framing.js';

export function createRelayServer({
  host = '0.0.0.0',
  port = 19078,
  token = ''
} = {}) {
  const phones = new Map();
  const pendingPc = new Map();
  const activeHdc = new Map();
  const bridgePc = [];

  const server = net.createServer((socket) => {
    void handleConnection(socket);
  });

  async function handleConnection(socket) {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let parsed;
    try {
      parsed = await readLine(socket);
    } catch (error) {
      socket.destroy();
      return;
    }

    const { line, lineBuffer, rest } = parsed;
    let hello;
    try {
      hello = JSON.parse(line);
    } catch {
      if (isHttpRequestLine(line)) {
        if (isRelayAdminRequest(line)) {
          registerRelayAdminHttp(socket, line);
          return;
        }
        registerBridgeHttp(socket, Buffer.concat([lineBuffer, rest]));
        return;
      }
      socket.destroy();
      return;
    }

    if (!isAuthorized(hello)) {
      writeJsonLine(socket, { ok: false, error: 'unauthorized' });
      socket.destroy();
      return;
    }

    if (hello.role === 'phone') {
      registerPhone(socket, hello, rest);
      return;
    }
    if (hello.role === 'pc') {
      registerPc(socket, hello, rest);
      return;
    }
    if (hello.role === 'bridge-pc') {
      registerBridgePc(socket, hello, rest);
      return;
    }

    writeJsonLine(socket, { ok: false, error: 'unknown role' });
    socket.destroy();
  }

  function isHttpRequestLine(line) {
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/1\.[01]$/i.test(line);
  }

  function isRelayAdminRequest(line) {
    const match = line.match(/^(GET|HEAD)\s+(\S+)\s+HTTP\/1\.[01]$/i);
    if (!match) {
      return false;
    }
    const url = new URL(match[2], 'http://relay.local');
    return url.pathname === '/__relay/state' || url.pathname === '/__relay/health';
  }

  function isAuthorized(hello) {
    if (!token) {
      return true;
    }
    return hello?.token === token;
  }

  function registerRelayAdminHttp(socket, line) {
    socket.on('error', () => {});
    const match = line.match(/^(GET|HEAD)\s+(\S+)\s+HTTP\/1\.[01]$/i);
    const url = new URL(match?.[2] ?? '/', 'http://relay.local');
    const queryToken = url.searchParams.get('token') ?? '';
    if (token && queryToken !== token) {
      writeHttpJson(socket, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    writeHttpJson(socket, 200, {
      ok: true,
      now: new Date().toISOString(),
      state: currentState()
    });
  }

  function writeHttpJson(socket, statusCode, body) {
    const text = JSON.stringify(body);
    const statusText = statusCode === 200 ? 'OK' : 'Unauthorized';
    socket.end([
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${Buffer.byteLength(text)}`,
      'cache-control: no-store',
      'connection: close',
      '',
      text
    ].join('\r\n'));
  }

  function currentState() {
    return {
      phones: [...phones.keys()],
      pendingPc: [...pendingPc.keys()],
      activeHdc: [...activeHdc.keys()],
      bridgePc: bridgePc.length
    };
  }

  function registerPhone(socket, hello, rest) {
    socket.on('error', () => {});
    const deviceId = String(hello.deviceId ?? 'default');
    if (process.env.HDC_RELAY_DEBUG === '1') {
      console.error(`[hdc-relay] phone hello device=${deviceId} rest=${rest.byteLength}`);
    }
    const waiting = pendingPc.get(deviceId);
    if (waiting) {
      pendingPc.delete(deviceId);
      writeJsonLine(socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
      writeJsonLine(waiting.socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
      rememberActiveHdc(deviceId, socket, waiting.socket);
      pipeBoth(waiting.socket, socket, waiting.rest, rest);
      return;
    }

    const existing = phones.get(deviceId);
    if (existing) {
      existing.destroy();
    }
    phones.set(deviceId, socket);
    writeJsonLine(socket, { ok: true, mode: 'waiting', deviceId });

    socket.on('close', () => {
      if (phones.get(deviceId) === socket) {
        phones.delete(deviceId);
      }
    });
    socket.on('error', () => {
      if (phones.get(deviceId) === socket) {
        phones.delete(deviceId);
      }
    });
  }

  function registerPc(socket, hello, rest) {
    socket.on('error', () => {});
    const deviceId = String(hello.deviceId ?? 'default');
    if (process.env.HDC_RELAY_DEBUG === '1') {
      console.error(`[hdc-relay] pc hello device=${deviceId} rest=${rest.byteLength}`);
    }
    const phone = phones.get(deviceId);
    const channelId = createChannelId();
    if (phone) {
      phones.delete(deviceId);
      writeJsonLine(socket, { ok: true, mode: 'paired', channelId });
      writeJsonLine(phone, { ok: true, mode: 'paired', channelId });
      rememberActiveHdc(deviceId, phone, socket);
      pipeBoth(socket, phone, rest);
      return;
    }

    const existing = pendingPc.get(deviceId);
    if (existing) {
      existing.socket.destroy();
    }
    pendingPc.set(deviceId, { socket, rest, channelId });
    writeJsonLine(socket, { ok: true, mode: 'waiting', deviceId, channelId });
    socket.on('close', () => {
      if (pendingPc.get(deviceId)?.socket === socket) {
        pendingPc.delete(deviceId);
      }
    });
    socket.on('error', () => {
      if (pendingPc.get(deviceId)?.socket === socket) {
        pendingPc.delete(deviceId);
      }
    });
  }

  function registerBridgePc(socket, hello, rest) {
    socket.on('error', () => {});
    const channelId = createChannelId();
    const item = { socket, rest, channelId };
    bridgePc.push(item);
    writeJsonLine(socket, { ok: true, mode: 'waiting', channelId });

    socket.on('close', () => removeBridgePc(item));
    socket.on('error', () => removeBridgePc(item));
  }

  function rememberActiveHdc(deviceId, phoneSocket, pcSocket) {
    const existing = activeHdc.get(deviceId);
    if (existing) {
      existing.phoneSocket.destroy();
      existing.pcSocket.destroy();
    }
    const item = { phoneSocket, pcSocket };
    activeHdc.set(deviceId, item);
    const cleanup = () => {
      if (activeHdc.get(deviceId) === item) {
        activeHdc.delete(deviceId);
      }
    };
    phoneSocket.on('close', cleanup);
    phoneSocket.on('error', cleanup);
    pcSocket.on('close', cleanup);
    pcSocket.on('error', cleanup);
  }

  function registerBridgeHttp(socket, initialData) {
    socket.on('error', () => {});
    const waiting = bridgePc.shift();
    if (!waiting) {
      socket.end([
        'HTTP/1.1 503 Service Unavailable',
        'content-type: application/json; charset=utf-8',
        'connection: close',
        '',
        JSON.stringify({ error: 'Desktop bridge tunnel is offline' })
      ].join('\r\n'));
      return;
    }

    writeJsonLine(waiting.socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
    pipeBoth(socket, waiting.socket, initialData, waiting.rest);
  }

  function removeBridgePc(item) {
    const index = bridgePc.indexOf(item);
    if (index >= 0) {
      bridgePc.splice(index, 1);
    }
  }

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, resolve);
      });
    },
    close() {
      for (const socket of phones.values()) {
        socket.destroy();
      }
      for (const item of pendingPc.values()) {
        item.socket.destroy();
      }
      for (const item of activeHdc.values()) {
        item.phoneSocket.destroy();
        item.pcSocket.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    },
    state() {
      return currentState();
    }
  };
}
