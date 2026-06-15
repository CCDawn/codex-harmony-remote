import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexDesktopCdpClient,
  extractConversationIdFromPath,
  isRetryableCdpTransportError,
  resolveDesktopCdpPort,
  resolveDesktopCdpPortCandidates
} from '../src/codexDesktopCdpClient.js';

test('extractConversationIdFromPath reads Codex desktop conversation routes', () => {
  assert.equal(
    extractConversationIdFromPath('/local/019e6a12-1a79-7bf2-ad67-83aa7d7c39f7'),
    '019e6a12-1a79-7bf2-ad67-83aa7d7c39f7'
  );
  assert.equal(
    extractConversationIdFromPath('/remote/019e-remote?foo=bar'),
    '019e-remote'
  );
  assert.equal(
    extractConversationIdFromPath('/hotkey-window/thread/019e-hotkey'),
    '019e-hotkey'
  );
  assert.equal(extractConversationIdFromPath('/settings'), null);
});

test('resolveDesktopCdpPort prefers explicit environment value', () => {
  assert.equal(resolveDesktopCdpPort({ CODEX_DESKTOP_CDP_PORT: '51413' }), 51413);
});

test('resolveDesktopCdpPortCandidates keeps stale desktop live status ports as fallbacks', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 61418,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    }));

    assert.deepEqual(resolveDesktopCdpPortCandidates({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), [61418, 9229]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveDesktopCdpPort accepts fresh desktop live status files', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51414,
      updatedAt: new Date().toISOString()
    }));

    assert.equal(resolveDesktopCdpPort({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), 51414);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveDesktopCdpPort ignores non-injected desktop live status files', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'starting',
      cdpPort: 51415,
      updatedAt: new Date().toISOString()
    }));

    assert.equal(resolveDesktopCdpPort({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), 9229);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CodexDesktopCdpClient refreshes the CDP port from the live status file', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  const previousPort = process.env.CODEX_DESKTOP_CDP_PORT;
  const previousStatusPath = process.env.CODEX_DESKTOP_CDP_STATUS_PATH;
  const previousMaxAge = process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS;
  try {
    delete process.env.CODEX_DESKTOP_CDP_PORT;
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    process.env.CODEX_DESKTOP_CDP_STATUS_PATH = statusPath;
    process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS = '600000';
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51416,
      updatedAt: new Date().toISOString()
    }));
    const client = new CodexDesktopCdpClient();
    assert.equal(client.port, 51416);

    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51417,
      updatedAt: new Date().toISOString()
    }));
    assert.equal(client.refreshPort(), 51417);
  } finally {
    if (previousPort === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_PORT;
    } else {
      process.env.CODEX_DESKTOP_CDP_PORT = previousPort;
    }
    if (previousStatusPath === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_STATUS_PATH;
    } else {
      process.env.CODEX_DESKTOP_CDP_STATUS_PATH = previousStatusPath;
    }
    if (previousMaxAge === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS;
    } else {
      process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS = previousMaxAge;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CDP disconnect closes the underlying socket and rejects pending calls', async () => {
  const client = new CodexDesktopCdpClient();
  let closed = 0;
  const socket = {
    close() {
      closed += 1;
    }
  };
  const pending = new Promise((resolve, reject) => {
    client.pending.set(1, {
      resolve,
      reject,
      timeout: setTimeout(() => {}, 10000)
    });
  });
  client.socket = socket;

  client.markDisconnected(socket, new Error('boom'));

  await assert.rejects(pending, /boom/);
  assert.equal(closed, 1);
  assert.equal(client.socket, null);
  assert.equal(client.connected, null);
  assert.equal(client.pending.size, 0);
});

test('concurrent CDP connection attempts share one in-flight socket setup', async () => {
  const client = new CodexDesktopCdpClient();
  let connects = 0;
  let release = () => {};
  const connected = new Promise((resolve) => {
    release = resolve;
  });
  client.connect = async () => {
    connects += 1;
    await connected;
    client.socket = {
      readyState: WebSocket.OPEN,
      close() {}
    };
  };

  const first = client.ensureConnected();
  const second = client.ensureConnected();
  await Promise.resolve();

  assert.equal(connects, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(connects, 1);
  assert.equal(client.connected, null);
});

test('CodexDesktopCdpClient retries retryable desktop read requests after a CDP transport error', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let attempts = 0;
  client.ensureConnected = async () => {};
  client.evaluate = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    return { thread: { id: '019e-target' } };
  };

  const result = await client.request('thread/read', { threadId: '019e-target' });

  assert.equal(attempts, 2);
  assert.equal(result.thread.id, '019e-target');
});

test('CodexDesktopCdpClient does not retry non-idempotent turn starts', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let attempts = 0;
  client.ensureConnected = async () => {};
  client.evaluate = async () => {
    attempts += 1;
    throw new Error('Codex 桌面 CDP 连接错误');
  };

  await assert.rejects(
    () => client.request('turn/start', { threadId: '019e-target', prompt: '继续' }),
    /Codex 桌面 CDP 连接错误/
  );
  assert.equal(attempts, 1);
});

test('isRetryableCdpTransportError only matches CDP transport failures', () => {
  assert.equal(isRetryableCdpTransportError(new Error('Codex 桌面 CDP 连接错误')), true);
  assert.equal(isRetryableCdpTransportError(new Error('Codex 桌面 app-server 请求失败')), false);
});
