import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import { createRelayServer } from '../src/hdc-relay/relayServer.js';
import { createLocalProxy } from '../src/hdc-relay/localProxy.js';
import { connectPhoneHelper } from '../src/hdc-relay/phoneHelperNode.js';
import { createBridgeProxy } from '../src/hdc-relay/bridgeProxy.js';

test('HDC relay bridges local proxy to phone helper TCP target', async () => {
  let client;
  let helper;
  let proxy;
  let relay;
  const fakeHdc = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
    });
  });
  fakeHdc.listen(0, '127.0.0.1');
  await once(fakeHdc, 'listening');

  relay = createRelayServer({ host: '127.0.0.1', port: 0, token: 'secret' });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const relayPort = relay.server.address().port;

  proxy = createLocalProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayHost: '127.0.0.1',
    relayPort,
    deviceId: 'phone-a',
    token: 'secret'
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const proxyPort = proxy.server.address().port;

  try {
    const helperPromise = connectPhoneHelper({
      relayHost: '127.0.0.1',
      relayPort,
      deviceId: 'phone-a',
      token: 'secret',
      hdcHost: '127.0.0.1',
      hdcPort: fakeHdc.address().port
    });

    await waitFor(() => relay.state().phones.includes('phone-a'));

    client = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    await once(client, 'connect');
    helper = await helperPromise;
    await waitFor(() => relay.state().activeHdc.includes('phone-a'));
    client.write('ping');

    const [chunk] = await once(client, 'data');
    assert.equal(chunk.toString(), 'echo:ping');
  } finally {
    client?.destroy();
    helper?.relaySocket?.destroy();
    helper?.hdcSocket?.destroy();
    await proxy.close().catch(() => {});
    await relay.close().catch(() => {});
    await new Promise((resolve) => fakeHdc.close(resolve));
  }
});

test('local proxy survives a client reset before relay pairing', async () => {
  let proxy;
  let relay;
  relay = createRelayServer({ host: '127.0.0.1', port: 0, token: 'secret' });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const relayPort = relay.server.address().port;

  proxy = createLocalProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayHost: '127.0.0.1',
    relayPort,
    deviceId: 'phone-a',
    token: 'secret'
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const proxyPort = proxy.server.address().port;

  try {
    const client = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    await once(client, 'connect');
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const nextClient = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    await once(nextClient, 'connect');
    nextClient.destroy();
  } finally {
    await proxy?.close().catch(() => {});
    await relay?.close().catch(() => {});
  }
});

test('relay forwards public HTTP requests to the desktop bridge proxy', async () => {
  let relay;
  let bridgeProxy;
  const fakeBridge = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('\r\n\r\n')) {
        socket.end([
          'HTTP/1.1 200 OK',
          'content-type: application/json',
          'content-length: 11',
          'connection: close',
          '',
          '{"ok":true}'
        ].join('\r\n'));
      }
    });
  });
  fakeBridge.listen(0, '127.0.0.1');
  await once(fakeBridge, 'listening');

  relay = createRelayServer({ host: '127.0.0.1', port: 0, token: 'secret' });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const relayPort = relay.server.address().port;

  bridgeProxy = createBridgeProxy({
    relayHost: '127.0.0.1',
    relayPort,
    token: 'secret',
    localBridgeHost: '127.0.0.1',
    localBridgePort: fakeBridge.address().port,
    poolSize: 1
  });
  bridgeProxy.start();

  try {
    await waitFor(() => relay.state().bridgePc === 1);
    const response = await fetch(`http://127.0.0.1:${relayPort}/health`, {
      headers: { 'x-codex-bridge-token': 'app-token' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await bridgeProxy?.close();
    await relay?.close().catch(() => {});
    await new Promise((resolve) => fakeBridge.close(resolve));
  }
});

test('bridge proxy replenishes waiting slots while HTTP keep-alive is open', async () => {
  let relay;
  let bridgeProxy;
  const heldBridgeSockets = [];
  const fakeBridge = net.createServer((socket) => {
    heldBridgeSockets.push(socket);
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('\r\n\r\n')) {
        socket.write([
          'HTTP/1.1 200 OK',
          'content-type: application/json',
          'content-length: 11',
          'connection: keep-alive',
          '',
          '{"ok":true}'
        ].join('\r\n'));
      }
    });
  });
  fakeBridge.listen(0, '127.0.0.1');
  await once(fakeBridge, 'listening');

  relay = createRelayServer({ host: '127.0.0.1', port: 0, token: 'secret' });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const relayPort = relay.server.address().port;

  bridgeProxy = createBridgeProxy({
    relayHost: '127.0.0.1',
    relayPort,
    token: 'secret',
    localBridgeHost: '127.0.0.1',
    localBridgePort: fakeBridge.address().port,
    poolSize: 1
  });
  bridgeProxy.start();

  try {
    await waitFor(() => relay.state().bridgePc === 1);
    const first = net.createConnection({ host: '127.0.0.1', port: relayPort });
    await once(first, 'connect');
    first.write('GET /health HTTP/1.1\r\nhost: relay\r\n\r\n');
    const [firstChunk] = await once(first, 'data');
    assert.match(firstChunk.toString('utf8'), /200 OK/);

    await waitFor(() => relay.state().bridgePc === 1);
    const second = net.createConnection({ host: '127.0.0.1', port: relayPort });
    await once(second, 'connect');
    second.write('GET /health HTTP/1.1\r\nhost: relay\r\n\r\n');
    const [secondChunk] = await once(second, 'data');
    assert.match(secondChunk.toString('utf8'), /200 OK/);
    first.destroy();
    second.destroy();
  } finally {
    for (const socket of heldBridgeSockets) {
      socket.destroy();
    }
    await bridgeProxy?.close();
    await relay?.close().catch(() => {});
    await new Promise((resolve) => fakeBridge.close(resolve));
  }
});

async function waitFor(check, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}
