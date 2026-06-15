import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopScriptBridge } from '../src/desktopScriptBridge.js';

test('DesktopScriptBridge verifies selected desktop session', () => {
  const bridge = new DesktopScriptBridge();

  assert.equal(bridge.getStatus('019e-target').status, 'unavailable');

  bridge.connect({
    scriptId: 'script-1',
    currentSessionId: 'local:019e-target'
  });

  const verified = bridge.getStatus('019e-target');
  assert.equal(verified.desktopLive, true);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.currentSessionId, '019e-target');
  assert.equal(verified.sessionVerified, true);

  const mismatch = bridge.getStatus('019e-other');
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.sessionVerified, false);
});

test('DesktopScriptBridge queues app-server requests and resolves responses', async () => {
  const bridge = new DesktopScriptBridge({ requestTimeoutMs: 500 });
  bridge.connect({ scriptId: 'script-1', currentSessionId: '019e-target' });

  const pending = bridge.request('thread/list', { limit: 1 });
  const commands = await bridge.poll({ scriptId: 'script-1', currentSessionId: '019e-target' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'mcp-request');
  assert.equal(commands[0].request.method, 'thread/list');

  bridge.receiveMessages({
    scriptId: 'script-1',
    currentSessionId: '019e-target',
    messages: [{
      type: 'mcp-response',
      hostId: 'local',
      message: {
        id: commands[0].request.id,
        result: { ok: true }
      }
    }]
  });

  assert.deepEqual(await pending, { ok: true });
});

test('DesktopScriptBridge queues host fetch commands and resolves responses', async () => {
  const bridge = new DesktopScriptBridge({ requestTimeoutMs: 500 });
  bridge.connect({ scriptId: 'script-1', currentSessionId: '019e-target' });

  const pending = bridge.fetchFromHost('send-follow-up-message', {
    conversationId: '019e-target',
    prompt: '你好'
  });
  const commands = await bridge.poll({ scriptId: 'script-1', currentSessionId: '019e-target' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'fetch');
  assert.equal(commands[0].url, 'vscode://codex/send-follow-up-message');
  assert.equal(JSON.parse(commands[0].body).conversationId, '019e-target');

  bridge.receiveMessages({
    scriptId: 'script-1',
    currentSessionId: '019e-target',
    messages: [{
      type: 'fetch-response',
      requestId: commands[0].requestId,
      responseType: 'success',
      bodyJsonString: JSON.stringify({ ok: true })
    }]
  });

  assert.deepEqual(await pending, { ok: true });
});

test('DesktopScriptBridge keeps only one active long poll per script', async () => {
  const bridge = new DesktopScriptBridge({ pollTimeoutMs: 5000 });
  bridge.connect({ scriptId: 'script-1', currentSessionId: '019e-target' });

  const firstPoll = bridge.poll({ scriptId: 'script-1', currentSessionId: '019e-target' });
  const secondPoll = bridge.poll({ scriptId: 'script-1', currentSessionId: '019e-target' });

  assert.deepEqual(await firstPoll, []);
  assert.equal(bridge.listenerCount('commands'), 1);

  const pending = bridge.request('thread/list', { limit: 1 });
  const commands = await secondPoll;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].request.method, 'thread/list');
  assert.equal(bridge.listenerCount('commands'), 0);

  bridge.receiveMessages({
    scriptId: 'script-1',
    currentSessionId: '019e-target',
    messages: [{
      type: 'mcp-response',
      hostId: 'local',
      message: {
        id: commands[0].request.id,
        result: { ok: true }
      }
    }]
  });
  assert.deepEqual(await pending, { ok: true });
});

test('DesktopScriptBridge rejects stale pollers without replacing the active script', async () => {
  const bridge = new DesktopScriptBridge({ pollTimeoutMs: 10 });
  bridge.connect({ scriptId: 'script-active', currentSessionId: '019e-target' }, { replace: true });

  const staleStatus = bridge.updateStatus({
    scriptId: 'script-stale',
    currentSessionId: '019e-other'
  });

  assert.equal(staleStatus.stale, true);
  assert.equal(staleStatus.activeScriptId, 'script-active');
  assert.equal(bridge.snapshot().scriptId, 'script-active');
  assert.equal(bridge.snapshot().currentSessionId, '019e-target');

  const commands = await bridge.poll({
    scriptId: 'script-stale',
    currentSessionId: '019e-other'
  });

  assert.deepEqual(commands, []);
  assert.equal(bridge.snapshot().scriptId, 'script-active');
});

test('DesktopScriptBridge connect replaces the active script after reinjection', () => {
  const bridge = new DesktopScriptBridge({ pollTimeoutMs: 10 });
  bridge.connect({ scriptId: 'script-old', currentSessionId: '019e-old' }, { replace: true });

  const connected = bridge.connect({
    scriptId: 'script-new',
    currentSessionId: '019e-new'
  }, { replace: true });

  assert.equal(connected.ok, true);
  assert.equal(bridge.snapshot().scriptId, 'script-new');
  assert.equal(bridge.snapshot().currentSessionId, '019e-new');
});

test('DesktopScriptBridge marks command channel degraded after app-server timeout', async () => {
  const bridge = new DesktopScriptBridge({
    requestTimeoutMs: 10,
    commandCircuitBreakerMs: 1000
  });
  bridge.connect({ scriptId: 'script-1', currentSessionId: '019e-target' });

  await assert.rejects(
    bridge.request('turn/start', { threadId: '019e-target' }),
    /等待桌面脚本桥 app-server 响应超时：turn\/start/
  );

  const status = bridge.getStatus('019e-target');
  assert.equal(status.desktopLive, false);
  assert.equal(status.status, 'degraded');
  assert.match(status.reason, /command channel timeout/);
  assert.equal(bridge.snapshot().commandChannelHealthy, false);
  assert.throws(
    () => bridge.request('thread/read', { threadId: '019e-target' }),
    /桌面脚本桥命令通道已临时熔断/
  );

  bridge.connect({ scriptId: 'script-2', currentSessionId: '019e-target' }, { replace: true });
  assert.equal(bridge.getStatus('019e-target').status, 'verified');
  assert.equal(bridge.snapshot().commandChannelHealthy, true);
});
