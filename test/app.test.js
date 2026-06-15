import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { CodexSessionStore } from '../src/codexSessions.js';
import { desktopScriptBridge } from '../src/desktopScriptBridge.js';
import { extractAccountUsageFromDesktopSnapshot } from '../src/codexAccountUsage.js';

function createTestConfig() {
  const sessionSettingsById = new Map();
  const config = {
    logger: new DiagnosticLogger({
      root: path.join(os.tmpdir(), `codex-app-test-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    }),
    desktopLiveRecovery: {
      shouldRecover() {
        return false;
      },
      async recover() {
        throw new Error('test recovery disabled');
      }
    },
    desktopLiveDiagnostics: false,
    async defaultReasoningEffortProvider() {
      return '';
    },
    sessionSettings: {
      async getSessionSettings(sessionId) {
        return sessionSettingsById.get(sessionId) ?? { model: '', reasoningEffort: '', updatedAt: '' };
      },
      async updateSessionSettings(sessionId, patch = {}) {
        const current = sessionSettingsById.get(sessionId) ?? { model: '', reasoningEffort: '', updatedAt: '' };
        const next = {
          model: Object.prototype.hasOwnProperty.call(patch, 'model') ? String(patch.model ?? '').trim() : current.model,
          reasoningEffort: Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort') ? String(patch.reasoningEffort ?? '').trim() : current.reasoningEffort,
          updatedAt: new Date().toISOString()
        };
        sessionSettingsById.set(sessionId, next);
        return next;
      },
      async deleteSessionSettings(sessionId) {
        sessionSettingsById.delete(sessionId);
      }
    },
    projects: [
      {
        id: 'probe',
        name: 'Probe Workspace',
        root: process.cwd(),
        allowedCommands: [/^npm\s+test$/]
      }
    ]
  };
  config.codexSettingsProvider = async () => ({
    model: 'gpt-test',
    reasoningEffort: await config.defaultReasoningEffortProvider(),
    models: [{
      id: 'gpt-test',
      model: 'gpt-test',
      displayName: 'GPT Test',
      description: 'Test default model',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
    }, {
      id: 'gpt-alt',
      model: 'gpt-alt',
      displayName: 'GPT Alt',
      description: 'Test alternate model',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium']
    }]
  });
  return config;
}

function testSessionFingerprint(overrides = {}) {
  return {
    title: '测试会话',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    filePath: 'C:\\sessions\\rollout.jsonl',
    entryCount: 2,
    ...overrides
  };
}

test('creates a task and exposes approval-driven lifecycle events', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: 'Fix the test failure'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const taskId = created.task.id;

    const approval = await waitForApproval(store, taskId);
    const approvalResponse = await fetch(`${baseUrl}/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    });
    assert.equal(approvalResponse.status, 200);

    const task = await waitForTaskStatus(store, taskId, 'completed');
    assert.equal(task.result.summary, 'Mock Codex task completed');
    assert.ok(task.events.some((event) => event.type === 'approval.required'));
    assert.ok(task.events.some((event) => event.type === 'task.completed'));
  } finally {
    server.close();
  }
});

test('lists task summaries', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: 'Fix the test failure'
      })
    });
    const created = await createResponse.json();
    await waitForApproval(store, created.task.id);

    const listResponse = await fetch(`${baseUrl}/tasks`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.task.id);
    assert.equal(listed.tasks[0].eventCount > 0, true);
  } finally {
    server.close();
  }
});

test('interrupts a running desktop-backed task through the task API', async () => {
  const config = createTestConfig();
  const adapter = new InterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '长任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));
    const listResponse = await fetch(`${baseUrl}/tasks`);
    const listed = await listResponse.json();
    const listedTask = listed.tasks.find((task) => task.id === created.task.id);
    assert.equal(listedTask.activeCodexTurnId, 'turn-interrupt-1');
    assert.equal(listedTask.interruptReady, true);

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    assert.equal(interrupted.task.interruptDispatching, true);
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.deepEqual(adapter.interrupted, {
      threadId: '019e-interrupt-thread',
      turnId: 'turn-interrupt-1'
    });
    assert.ok(store.getTask(created.task.id).events.some((event) => event.type === 'task.interrupted'));
  } finally {
    server.close();
  }
});

test('interrupts a running task by Codex session id', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '可中断会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-30T00:00:00.000Z'
      };
    }
  };
  const adapter = new InterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '长任务',
        codexSessionId: '019e-interrupt-thread',
        sessionFingerprint: testSessionFingerprint({ title: '可中断会话' })
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/api/codex/threads/019e-interrupt-thread/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.run.id, created.task.id);
    assert.equal(interrupted.run.status, 'running');
    assert.equal(interrupted.run.interruptRequested, true);
    assert.equal(interrupted.run.interruptDispatching, true);
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.deepEqual(adapter.interrupted, {
      threadId: '019e-interrupt-thread',
      turnId: 'turn-interrupt-1'
    });
  } finally {
    server.close();
  }
});

test('acknowledges slow Codex interrupts before desktop dispatch finishes', async () => {
  const config = createTestConfig();
  const adapter = new SlowInterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '慢中断任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptPromise = fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    const timeout = delay(100).then(() => 'timeout');
    const responseOrTimeout = await Promise.race([interruptPromise, timeout]);
    assert.notEqual(responseOrTimeout, 'timeout');

    const interruptResponse = responseOrTimeout;
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();
    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    await until(() => adapter.interruptStarted);
    assert.equal(adapter.interruptStarted, true);
    assert.equal(adapter.interrupted, null);

    adapter.releaseInterrupt();
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.deepEqual(adapter.interrupted, {
      threadId: '019e-interrupt-thread',
      turnId: 'turn-interrupt-1'
    });
  } finally {
    server.close();
  }
});

test('confirms fast interrupt dispatch failures for mobile callers', async () => {
  const config = createTestConfig();
  const adapter = new FailingInterruptAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '无法中断的长任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, false);
    assert.equal(interrupted.task.interruptDispatching, false);
    assert.equal(interrupted.task.interruptError, 'Codex 桌面 CDP 连接错误');
    assert.equal(interrupted.task.error, '中断失败：Codex 桌面 CDP 连接错误');
    assert.equal(interrupted.task.latestEvent.type, 'task.interrupt.failed');
  } finally {
    server.close();
  }
});

test('rejects interrupting an already completed task', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new FastAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '短任务'
      })
    });
    const created = await createResponse.json();
    await waitForTaskStatus(store, created.task.id, 'completed');

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 409);
  } finally {
    server.close();
  }
});

test('uploads a phone image and returns a local Codex-readable path', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'screen.png',
        mimeType: 'image/png',
        base64: Buffer.from('fake-png').toString('base64')
      })
    });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    assert.equal(uploaded.image.mimeType, 'image/png');
    assert.equal(uploaded.image.bytes, 8);
    assert.ok(uploaded.image.filePath.endsWith('.png'));
    assert.equal(uploaded.image.messageText, `![手机端图片](${uploaded.image.filePath.replace(/\\/g, '/')})`);
    assert.equal(uploaded.image.messageText.includes('请查看并结合当前对话回复'), false);
    assert.equal(uploaded.image.messageText.includes('图片路径：'), false);
    assert.equal(await fs.readFile(uploaded.image.filePath, 'utf8'), 'fake-png');
  } finally {
    server.close();
  }
});

test('serves uploaded phone images for mobile preview', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-preview-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const imagePath = path.join(config.mobileImagesDir, 'preview.png');
    await fs.writeFile(imagePath, Buffer.from('fake-png'));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images/file?path=${encodeURIComponent(imagePath)}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), 'fake-png');
  } finally {
    server.close();
  }
});

test('rejects mobile image preview paths outside upload directory', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-preview-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const outsidePath = path.join(os.tmpdir(), 'outside-preview.png');
    await fs.writeFile(outsidePath, Buffer.from('fake-png'));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images/file?path=${encodeURIComponent(outsidePath)}`);

    assert.equal(response.status, 403);
  } finally {
    server.close();
  }
});

test('creates a task from a short Chinese chat message', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '你好'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(store.getTask(created.task.id).prompt, '你好');
  } finally {
    server.close();
  }
});

test('creates a task for an existing Codex session', async () => {
  const config = createTestConfig();
  const sessions = {
    async verifySessionTarget(sessionId, fingerprint) {
      return {
        id: sessionId,
        title: fingerprint?.title ?? '测试会话',
        projectRoot: fingerprint?.projectRoot ?? 'C:\\work',
        projectLabel: fingerprint?.projectLabel ?? 'work',
        filePath: fingerprint?.filePath ?? 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  config.sessions = sessions;
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '019e-test-session',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.task.codexSessionId, '019e-test-session');

    const task = store.getTask(created.task.id);
    assert.equal(task.codexSessionId, '019e-test-session');
    assert.equal(task.events[0].payload.codexSessionId, '019e-test-session');
    assert.equal(task.verifiedSessionTarget.filePath, 'C:\\sessions\\rollout.jsonl');
  } finally {
    server.close();
  }
});

test('records the created Codex session id for new tasks', async () => {
  const config = createTestConfig();
  const adapter = {
    async run({ emit }) {
      emit('codex.exec.event', {
        type: 'thread.started',
        thread_id: '019e-new-session'
      });
      return {
        summary: '新会话已创建',
        changedFiles: [],
        tests: []
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '新建一个会话并分析项目'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    assert.equal(task.createdCodexSessionId, '019e-new-session');
    assert.equal(task.codexSessionId, '019e-new-session');

    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.createdCodexSessionId, '019e-new-session');
    assert.equal(fetched.task.codexSessionId, '019e-new-session');
  } finally {
    server.close();
  }
});

test('exposes desktop sync status for CLI-backed Codex tasks', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '测试会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  const desktopSync = {
    status: 'file_only',
    desktopLive: false,
    mode: 'resume',
    message: '已写入 Codex 本地会话文件；当前 Codex 桌面窗口不会自动实时刷新这条外部写入。',
    reason: '独立 CLI 进程不会通知桌面 app-server。'
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.desktop_sync', desktopSync);
      return {
        summary: '已发送到会话',
        changedFiles: [],
        tests: [],
        desktopSync
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '019e-test-session',
        sessionFingerprint: testSessionFingerprint()
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');
    assert.deepEqual(task.desktopSync, desktopSync);

    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.desktopSync.desktopLive, false);
    assert.equal(fetched.task.result.desktopSync.status, 'file_only');
    assert.ok(fetched.task.events.some((event) => event.type === 'codex.desktop_sync'));
  } finally {
    server.close();
  }
});

test('does not request desktop refresh for blocked existing-session tasks', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '测试会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.desktop_sync', {
        status: 'desktop_live_required',
        desktopLive: false,
        mode: 'resume'
      });
      return {
        summary: '桌面官方通道未连接',
        changedFiles: [],
        tests: [],
        desktopSync: {
          status: 'desktop_live_required',
          desktopLive: false,
          mode: 'resume'
        }
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话',
        codexSessionId: '019e-test-session',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');
    const eventTypes = task.events.map((event) => event.type);

    assert.ok(eventTypes.includes('codex.desktop_sync'));
    assert.ok(!eventTypes.includes('codex.desktop_session.refresh_requested'));
    assert.ok(!eventTypes.includes('codex.desktop_session.refresh_failed'));
  } finally {
    server.close();
  }
});

test('exposes desktop live status without creating a task', async () => {
  const config = createTestConfig();
  const adapter = {
    checked: 0,
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      this.checked += 1;
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: `timeout=${timeoutMs}`,
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/status?sessionId=019e-test-session`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.desktop.desktopLive, false);
    assert.equal(body.desktop.reason, 'timeout=8000');
    assert.equal(body.desktop.targetSessionId, '019e-test-session');
    assert.equal(body.desktop.sessionVerified, false);
    assert.equal(adapter.checked, 1);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('classifies ordinary Codex without CDP as not mobile-recoverable', async () => {
  const config = createTestConfig();
  let recoverCalled = false;
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: true,
        cdpPort: 60568,
        lastInjectedCdpPort: 60568,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover() {
      recoverCalled = true;
      throw new Error('should not soft recover plain Codex');
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/status?sessionId=019e-test-session&recover=1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.desktop.desktopLive, false);
    assert.equal(body.desktop.failureClass, 'codex_plain_no_cdp');
    assert.equal(body.desktop.desktopProcessMode, 'plain');
    assert.equal(body.desktop.requiresDesktopCdp, true);
    assert.equal(body.desktop.mobileRecoverable, false);
    assert.match(body.desktop.recoveryHint, /普通启动态|CDP/);
    assert.equal(recoverCalled, false);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('captures primary desktop screenshot without exposing a file path', async () => {
  const config = createTestConfig();
  config.desktopScreenshotProvider = async () => ({
    mimeType: 'image/png',
    base64: Buffer.from('fake-screen').toString('base64'),
    bytes: 11,
    width: 1920,
    height: 1080,
    capturedAt: '2026-05-30T00:00:00.000Z',
    durationMs: 12
  });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/screenshot/primary`, {
      method: 'POST'
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.image.mimeType, 'image/png');
    assert.equal(body.image.base64, Buffer.from('fake-screen').toString('base64'));
    assert.equal(body.image.bytes, 11);
    assert.equal(body.image.width, 1920);
    assert.equal(body.image.height, 1080);
    assert.equal(body.image.filePath, undefined);

    await logger.flushAnalysis();
    const bridgeLog = await fs.readFile(path.join(config.logger.currentRunDir, 'bridge.jsonl'), 'utf8');
    assert.match(bridgeLog, /desktop\.screenshot\.captured/);
    assert.doesNotMatch(bridgeLog, /filePath/);
  } finally {
    server.close();
  }
});

test('exposes live Codex session snapshot from completed tasks', async () => {
  const config = createTestConfig();
  const liveSession = {
    id: '019e-live-session',
    title: '手机测试会话',
    updatedAt: '2026-05-28T10:00:00.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    pinned: false,
    detailAvailable: true,
    filePath: '',
    entries: [
      {
        timestamp: '2026-05-28T10:00:00.000Z',
        type: 'userMessage',
        role: 'user',
        text: '你好'
      },
      {
        timestamp: '2026-05-28T10:00:01.000Z',
        type: 'agentMessage',
        role: 'assistant',
        text: '你好，我已开始工作。'
      }
    ],
    entryCount: 2
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.app_server.thread.ready', {
        threadId: liveSession.id,
        sessionId: liveSession.id
      });
      return {
        summary: '你好，我已开始工作。',
        changedFiles: [],
        tests: [],
        session: liveSession
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '你好'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    assert.equal(task.createdCodexSessionId, liveSession.id);
    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.session.id, liveSession.id);
    assert.deepEqual(fetched.task.session.entries.map((entry) => entry.text), ['你好', '你好，我已开始工作。']);
  } finally {
    server.close();
  }
});

test('returns lightweight task payloads by default and preserves full debug payloads', async () => {
  const config = createTestConfig();
  const largeText = 'x'.repeat(1200);
  const adapter = {
    async run({ emit }) {
      emit('codex.app_server.thread.read', {
        thread: {
          id: '019e-large-thread',
          turns: Array.from({ length: 60 }, (_, index) => ({
            id: `turn-${index}`,
            status: 'completed',
            items: [{ type: 'agentMessage', text: `${index}:${largeText}` }]
          }))
        }
      });
      for (let index = 0; index < 80; index += 1) {
        emit('codex.session_file.turn.waiting_terminal', {
          threadId: '019e-large-thread',
          message: `waiting ${index}`,
          blob: largeText
        });
      }
      return {
        summary: largeText,
        changedFiles: [],
        tests: [],
        exitCode: 0,
        session: {
          id: '019e-large-thread',
          title: '大响应测试',
          updatedAt: '2026-06-12T00:00:00.000Z',
          detailAvailable: true,
          entries: Array.from({ length: 120 }, (_, index) => ({
            timestamp: '2026-06-12T00:00:00.000Z',
            type: index % 2 === 0 ? 'userMessage' : 'agentMessage',
            role: index % 2 === 0 ? 'user' : 'assistant',
            text: largeText
          })),
          entryCount: 120
        }
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '触发大响应'
      })
    });
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    const lightResponse = await fetch(`${baseUrl}/tasks/${task.id}`);
    const lightText = await lightResponse.text();
    assert.equal(lightResponse.status, 200);
    assert.ok(Buffer.byteLength(lightText) < 20 * 1024, `light payload was ${Buffer.byteLength(lightText)} bytes`);
    const light = JSON.parse(lightText);
    assert.equal(light.task.session.entries, undefined);
    assert.equal(light.task.session.latestEntry.text.length < largeText.length, true);
    assert.equal(light.task.events.length <= 8, true);
    assert.equal(light.task.events.some((event) => event.payload?.truncated === true), true);
    assert.equal(light.task.result, undefined);
    assert.equal(light.task.resultSummary.summary.length < largeText.length, true);

    const fullResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const full = await fullResponse.json();
    assert.equal(full.task.session.entries.length, 120);
    assert.equal(full.task.events.length > light.task.events.length, true);
    assert.equal(full.task.result.session.entries.length, 120);
  } finally {
    server.close();
  }
});

test('deletes Codex threads through mobile POST alias', async () => {
  const deletedIds = [];
  const config = createTestConfig();
  config.threadService = {
    async deleteThread(threadId) {
      deletedIds.push(threadId);
      return {
        id: threadId,
        deletedFiles: ['rollout.jsonl'],
        archivedThreadCount: 1,
        removedIndexRecords: 1,
        removedGlobalStateEntries: 1
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-delete-session/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(deletedIds, ['019e-delete-session']);
    assert.equal(body.deleted.id, '019e-delete-session');
    assert.equal(body.deleted.archivedThreadCount, 1);
  } finally {
    server.close();
  }
});

test('deletes legacy Codex sessions through POST alias', async () => {
  const deletedIds = [];
  const config = createTestConfig();
  config.threadService = {
    async deleteThread(threadId) {
      deletedIds.push(threadId);
      return {
        id: threadId,
        deletedFiles: [],
        archivedThreadCount: 1,
        removedIndexRecords: 1,
        removedGlobalStateEntries: 0
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/codex/sessions/019e-delete-legacy/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(deletedIds, ['019e-delete-legacy']);
    assert.equal(body.deleted.id, '019e-delete-legacy');
    assert.equal(body.deleted.removedIndexRecords, 1);
  } finally {
    server.close();
  }
});

test('rejects invalid Codex session ids', async () => {
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '../bad'
      })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid Codex session id');
  } finally {
    server.close();
  }
});

test('rejects stale session fingerprints before sending to Codex', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget() {
      const error = new Error('手机端会话文件指纹已过期，已阻止发送。请重新打开这个会话后再发送。');
      error.statusCode = 409;
      throw error;
    }
  };
  const adapter = {
    async run() {
      throw new Error('should not run Codex for stale targets');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话',
        codexSessionId: '019e-test-session',
        sessionFingerprint: {
          filePath: 'C:\\old\\rollout.jsonl'
        }
      })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.error, /会话文件指纹已过期/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('CodexSessionStore filters internal context from session details', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
    id: '019e-visible-session',
    thread_name: '可见会话',
    updated_at: '2026-05-28T00:00:00.000Z'
  })}\n`);
  await fs.writeFile(path.join(sessionDir, 'rollout-019e-visible-session.jsonl'), [
    JSON.stringify({
      timestamp: '2026-05-28T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: '<permissions instructions>\nsecret'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<environment_context>\nsecret'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '你好'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '你好，我会用中文继续。' }]
      }
    })
  ].join('\n'));

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession('019e-visible-session', { tail: 20 });
  assert.deepEqual(detail.entries.map((entry) => entry.text), ['你好', '你好，我会用中文继续。']);
});

test('requires token when CODEX_BRIDGE_TOKEN is set', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rejected = await fetch(`${baseUrl}/projects`);
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${baseUrl}/projects`, {
      headers: { 'x-codex-bridge-token': 'secret-token' }
    });
    assert.equal(accepted.status, 200);
  } finally {
    server.close();
    if (previous === undefined) {
      delete process.env.CODEX_BRIDGE_TOKEN;
    } else {
      process.env.CODEX_BRIDGE_TOKEN = previous;
    }
  }
});

test('redacts query tokens from bridge request logs', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousLogDir = process.env.CODEX_BRIDGE_LOG_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-logs-'));
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  process.env.CODEX_BRIDGE_LOG_DIR = root;
  const config = createTestConfig();
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/projects?token=secret-token`);
    assert.equal(response.status, 200);
    await logger.flushAnalysis();

    const bridgeLog = await fs.readFile(path.join(root, 'current-run', 'bridge.jsonl'), 'utf8');
    assert.match(bridgeLog, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
    assert.doesNotMatch(bridgeLog, /secret-token/);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_LOG_DIR', previousLogDir);
  }
});

test('accepts batched mobile logs while keeping single log compatibility', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-batch-logs-'));
  const config = createTestConfig();
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const batchResponse = await fetch(`${baseUrl}/logs/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        logs: [
          { source: 'harmony-app', level: 'info', event: 'traffic.batch.one', data: 'first' },
          { source: 'harmony-app', level: 'warn', event: 'traffic.batch.two', data: { second: true } }
        ]
      })
    });
    assert.equal(batchResponse.status, 202);
    const batch = await batchResponse.json();
    assert.equal(batch.count, 2);

    const singleResponse = await fetch(`${baseUrl}/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'harmony-app', level: 'info', event: 'traffic.single', data: 'single' })
    });
    assert.equal(singleResponse.status, 202);
    await logger.flushAnalysis();

    const appLog = await fs.readFile(path.join(root, 'current-run', 'harmony-app.jsonl'), 'utf8');
    assert.match(appLog, /traffic\.batch\.one/);
    assert.match(appLog, /traffic\.batch\.two/);
    assert.match(appLog, /traffic\.single/);
  } finally {
    server.close();
  }
});

test('records actual HTTP response byte counts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-response-bytes-'));
  const config = createTestConfig();
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/projects`);
    assert.equal(response.status, 200);
    await response.text();
    await logger.flushAnalysis();

    const bridgeLog = await fs.readFile(path.join(root, 'current-run', 'bridge.jsonl'), 'utf8');
    const completed = bridgeLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'http.request.completed' && entry.data.url === '/projects');
    assert.equal(completed.data.responseBytes > 0, true);
    assert.equal(completed.data.trafficClass, 'small');
  } finally {
    server.close();
  }
});

test('does not access-log desktop script bridge heartbeats', async () => {
  const config = createTestConfig();
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    desktopScriptBridge.reset();
    desktopScriptBridge.connect({
      scriptId: 'script-test',
      currentSessionId: '019e-test-session'
    }, { replace: true });
    const pending = desktopScriptBridge.request('thread/list', { limit: 1 });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/script/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'script-test',
        currentSessionId: '019e-test-session'
      })
    });
    assert.equal(response.status, 200);
    const polled = await response.json();
    assert.equal(polled.commands.length, 1);

    const messagesResponse = await fetch(`${baseUrl}/desktop/script/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
      scriptId: 'script-test',
      currentSessionId: '019e-test-session',
      messages: [{
        type: 'mcp-response',
        message: {
          id: polled.commands[0].request.id,
          result: { ok: true }
        }
      }]
      })
    });
    assert.equal(messagesResponse.status, 202);
    assert.deepEqual(await pending, { ok: true });

    await logger.flushAnalysis();
    const bridgeLog = await fs.readFile(path.join(config.logger.currentRunDir, 'bridge.jsonl'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    assert.doesNotMatch(bridgeLog, /http\.request\.completed.*desktop\/script\/poll/);
    assert.doesNotMatch(bridgeLog, /http\.request\.completed.*desktop\/script\/messages/);
  } finally {
    desktopScriptBridge.reset();
    server.close();
  }
});

test('rejects non-object JSON bodies with a 400', async () => {
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(null)
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Request body must be a JSON object');
  } finally {
    server.close();
  }
});

test('exposes official Codex thread API for new phone conversations', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/api/codex/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'probe', text: '你好', model: 'gpt-alt', reasoningEffort: 'medium' })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.thread.id, 'thread-1');
    assert.equal(created.run.codexSessionId, 'thread-1');
    assert.equal(created.run.model, 'gpt-alt');
    assert.equal(created.run.reasoningEffort, 'medium');
    assert.equal(config.threadService.run.model, 'gpt-alt');
    assert.equal(config.threadService.run.reasoningEffort, 'medium');
    assert.equal((await config.sessionSettings.getSessionSettings('thread-1')).model, 'gpt-alt');
    assert.equal((await config.sessionSettings.getSessionSettings('thread-1')).reasoningEffort, 'medium');
  } finally {
    server.close();
  }
});

test('persists per-session reasoning effort settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'xhigh';
  config.threadService = new FakeThreadService();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const updateResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-alt', reasoningEffort: 'high' })
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.settings.model, 'gpt-alt');
    assert.equal(updated.settings.defaultModel, 'gpt-test');
    assert.equal(updated.settings.effectiveModel, 'gpt-alt');
    assert.equal(updated.settings.modelSource, 'session');
    assert.equal(updated.settings.modelOptions.length, 2);
    assert.equal(updated.settings.reasoningEffort, 'high');
    assert.equal(updated.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(updated.settings.effectiveReasoningEffort, 'high');
    assert.equal(updated.settings.reasoningEffortSource, 'session');

    const getResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const fetched = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(fetched.settings.model, 'gpt-alt');
    assert.equal(fetched.settings.defaultModel, 'gpt-test');
    assert.equal(fetched.settings.effectiveModel, 'gpt-alt');
    assert.equal(fetched.settings.reasoningEffort, 'high');
    assert.equal(fetched.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(fetched.settings.effectiveReasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('exposes desktop default reasoning effort for automatic session settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'xhigh';
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const globalResponse = await fetch(`${baseUrl}/api/codex/settings`);
    const globalBody = await globalResponse.json();
    assert.equal(globalResponse.status, 200);
    assert.equal(globalBody.settings.model, '');
    assert.equal(globalBody.settings.defaultModel, 'gpt-test');
    assert.equal(globalBody.settings.effectiveModel, 'gpt-test');
    assert.equal(globalBody.settings.modelSource, 'desktop');
    assert.equal(globalBody.settings.modelOptions.length, 2);
    assert.equal(globalBody.settings.reasoningEffort, '');
    assert.equal(globalBody.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(globalBody.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(globalBody.settings.reasoningEffortSource, 'desktop');

    const sessionResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionBody.settings.model, '');
    assert.equal(sessionBody.settings.defaultModel, 'gpt-test');
    assert.equal(sessionBody.settings.effectiveModel, 'gpt-test');
    assert.equal(sessionBody.settings.reasoningEffort, '');
    assert.equal(sessionBody.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(sessionBody.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(sessionBody.settings.reasoningEffortSource, 'desktop');
  } finally {
    server.close();
  }
});

test('exposes Codex account usage from the configured usage provider', async () => {
  const config = createTestConfig();
  let called = false;
  config.accountUsageProvider = async () => {
    called = true;
    return {
      ok: true,
      status: 'available',
      source: 'test_provider',
      checkedAt: '2026-06-14T00:00:00.000Z',
      planName: 'Pro',
      usageText: '本月已用 12%',
      balanceText: '剩余额度 88%',
      items: [{
        kind: 'plan',
        label: '套餐',
        value: 'Pro'
      }]
    };
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/account/usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.equal(body.usage.ok, true);
    assert.equal(body.usage.source, 'test_provider');
    assert.equal(body.usage.planName, 'Pro');
    assert.equal(body.usage.items[0].label, '套餐');
  } finally {
    server.close();
  }
});

test('does not classify ordinary desktop session list text as Codex account usage', () => {
  const usage = extractAccountUsageFromDesktopSnapshot({
    title: 'Codex',
    location: 'app://codex',
    accountContext: false,
    lines: [
      '对话 会话修复 2 天 解释 Claude auto mode 3 天 评估美国家宽可行性 3 天',
      '会话修复 2 天',
      '这是普通聊天消息，不是账号用量页面'
    ]
  }, { checkedAt: '2026-06-14T00:00:00.000Z' });

  assert.equal(usage.ok, false);
  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.items, []);
});

test('does not classify context usage or prose urls as account usage', () => {
  const usage = extractAccountUsageFromDesktopSnapshot({
    title: 'Codex',
    location: 'app://codex/thread',
    accountContext: true,
    lines: [
      '上下文用量：76%',
      'proceedings.iclr.cc/paper_files/paper/2025/file/example-Paper-Conference.pdf'
    ]
  }, { checkedAt: '2026-06-14T00:00:00.000Z' });

  assert.equal(usage.ok, false);
  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.items, []);
});

test('classifies Codex account usage only when account UI context is present', () => {
  const usage = extractAccountUsageFromDesktopSnapshot({
    title: 'Codex',
    location: 'app://codex/settings/account',
    accountContext: true,
    lines: [
      'Codex Pro plan',
      'Usage used 12%',
      'Remaining credits 88%'
    ]
  }, { checkedAt: '2026-06-14T00:00:00.000Z' });

  assert.equal(usage.ok, true);
  assert.equal(usage.status, 'available');
  assert.equal(usage.planName, 'Codex Pro plan');
  assert.equal(usage.balanceText, 'Remaining credits 88%');
});

test('sends existing phone thread messages through the desktop-backed task path', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let desktopOpenCalled = false;
  config.desktopOpener = async () => {
    desktopOpenCalled = true;
    throw new Error('should not open desktop thread during phone send');
  };
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        },
        model: 'gpt-alt',
        reasoningEffort: 'high'
      })
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(body.run.prompt, '继续');
    assert.equal(store.listTasks().length, 1);
    assert.equal(config.threadService.sentMessages.length, 0);
    assert.equal(desktopOpenCalled, false);
    assert.equal(adapter.runs.length, 1);
    assert.equal(adapter.runs[0].codexSessionId, '019e-test-session');
    assert.equal(adapter.runs[0].model, 'gpt-alt');

    const task = await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(task.result.desktopSync.status, 'desktop_live');

    const runResponse = await fetch(`${baseUrl}/api/codex/runs/${body.run.id}`);
    const runBody = await runResponse.json();
    assert.equal(runResponse.status, 200);
    assert.equal(runBody.run.id, body.run.id);
    assert.equal(runBody.run.status, 'completed');
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'high');
    assert.equal(adapter.runs[0].reasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('uses stored reasoning effort when a phone thread message omits it', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  await config.sessionSettings.updateSessionSettings('019e-test-session', { model: 'gpt-alt', reasoningEffort: 'xhigh' });
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'xhigh');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-alt');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'xhigh');
  } finally {
    server.close();
  }
});

test('uses desktop default reasoning effort when phone thread message is automatic', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        reasoningEffort: '',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-test');
    assert.equal(body.run.reasoningEffort, 'high');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-test');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('reports desktop per-thread reasoning effort for automatic session settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.sessions = new FakeSessionVerifier({
    modelBySessionId: new Map([['019e-test-session', 'gpt-alt']]),
    reasoningEffortBySessionId: new Map([['019e-test-session', 'xhigh']])
  });
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.settings.reasoningEffort, '');
    assert.equal(body.settings.defaultModel, 'gpt-alt');
    assert.equal(body.settings.effectiveModel, 'gpt-alt');
    assert.equal(body.settings.modelSource, 'desktop');
    assert.equal(body.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(body.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(body.settings.reasoningEffortSource, 'desktop');
  } finally {
    server.close();
  }
});

test('uses desktop per-thread reasoning effort when automatic phone thread message is sent', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier({
    modelBySessionId: new Map([['019e-test-session', 'gpt-alt']]),
    reasoningEffortBySessionId: new Map([['019e-test-session', 'xhigh']])
  });
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        reasoningEffort: '',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'xhigh');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-alt');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'xhigh');
  } finally {
    server.close();
  }
});

test('rejects existing phone thread messages without a session fingerprint', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'probe', text: '继续' })
    });

    const body = await response.json();
    assert.equal(response.status, 409);
    assert.match(body.error, /缺少会话指纹/);
    assert.equal(store.listTasks().length, 0);
    assert.equal(adapter.runs.length, 0);
  } finally {
    server.close();
  }
});

test('queues existing phone thread messages and reports desktop verification failure in task status', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      this.checkedSessionId = sessionId;
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run({ task, emit }) {
      throw new Error('should not reach adapter run without verified desktop live');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(store.listTasks().length, 1);
    assert.equal(config.threadService.sentMessages.length, 0);
    const task = await waitForTaskStatus(store, body.run.id, 'failed');
    assert.match(task.error, /桌面端未确认当前会话/);
    assert.equal(adapter.checkedSessionId, '019e-test-session');
  } finally {
    server.close();
  }
});

test('returns an existing phone thread task before slow desktop verification finishes', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let releaseVerification;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      await new Promise((resolve) => {
        releaseVerification = resolve;
      });
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '慢校验后已确认当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      };
    },
    async run({ task, emit }) {
      emit('codex.desktop_sync', {
        status: 'desktop_live',
        desktopLive: true,
        mode: 'resume'
      });
      return {
        summary: 'done',
        changedFiles: [],
        tests: [],
        session: { id: task.codexSessionId, entries: [] },
        desktopSync: { status: 'desktop_live', desktopLive: true },
        exitCode: 0
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(elapsedMs < 1000, true);
    assert.equal(store.getTask(body.run.id).status, 'running');
    releaseVerification();
    await waitForTaskStatus(store, body.run.id, 'completed');
  } finally {
    server.close();
  }
});

test('soft-recovers desktop live before sending an existing phone thread task', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let recoverCalled = false;
  let recovered = false;
  let runCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return recovered ? {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '软恢复后已校验当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      } : {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run({ task, emit }) {
      runCalled = true;
      emit('codex.desktop_sync', {
        status: 'desktop_live',
        desktopLive: true,
        mode: 'resume'
      });
      return {
        summary: 'done',
        changedFiles: [],
        tests: [],
        session: { id: task.codexSessionId, entries: [] },
        desktopSync: { status: 'desktop_live', desktopLive: true },
        exitCode: 0
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId }) {
      assert.equal(sessionId, '019e-test-session');
      recoverCalled = true;
      recovered = true;
      return { attempted: true, ok: true };
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(store.listTasks().length, 1);
    const task = await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(task.verifiedDesktopStatus.recoveryAttempted, true);
    assert.equal(task.verifiedDesktopStatus.recoveryOk, true);
    assert.equal(recoverCalled, true);
    assert.equal(runCalled, true);
  } finally {
    server.close();
  }
});

test('reports soft recovery failure without running an existing phone thread task', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let recoverCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not reach adapter run after failed soft recovery');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId }) {
      assert.equal(sessionId, '019e-test-session');
      recoverCalled = true;
      throw new Error('未找到现有 Codex CDP 端口，软恢复已停止');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    const task = await waitForTaskStatus(store, body.run.id, 'failed');
    assert.equal(recoverCalled, true);
    assert.match(task.error, /桌面端未确认当前会话/);
    assert.match(task.verifiedDesktopStatus.recoveryError, /软恢复已停止/);
  } finally {
    server.close();
  }
});

test('manually recovers desktop live from explicit recover endpoint', async () => {
  const config = createTestConfig();
  let recovered = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return recovered ? {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '手动恢复后已校验当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      } : {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId, reason }) {
      assert.equal(sessionId, '019e-test-session');
      assert.match(reason, /manual:mobile_button/);
      recovered = true;
      return { attempted: true, ok: true };
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, true);
    assert.equal(body.desktop.desktopLive, true);
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, true);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('returns manual desktop recovery errors without creating a task', async () => {
  const config = createTestConfig();
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover() {
      throw new Error('恢复脚本失败');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, false);
    assert.match(body.desktop.reason, /手动恢复失败/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop recovery skips soft script when Codex lacks CDP', async () => {
  const config = createTestConfig();
  let recoverCalled = false;
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recoverCalled = true;
      throw new Error('should not run recovery script');
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recoverCalled, false);
    assert.equal(body.desktop.recoveryAttempted, false);
    assert.equal(body.desktop.recoveryOk, false);
    assert.equal(body.desktop.requiresDesktopCdp, true);
    assert.equal(body.desktop.mobileRecoverable, false);
    assert.equal(body.desktop.failureClass, 'codex_plain_no_cdp');
    assert.match(body.desktop.recoveryError, /手机端软恢复无法接入|CDP/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop recovery can hard-restart CDP when requested by the phone', async () => {
  const config = createTestConfig();
  let recovered = false;
  let recoveryMode = '';
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return {
          failureClass: 'none',
          desktopProcessMode: 'cdp',
          requiresDesktopCdp: false,
          mobileRecoverable: true,
          cdpPort: 9229
        };
      }
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover(input) {
      recoveryMode = input.mode;
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      if (recovered) {
        return {
          ok: true,
          desktopLive: true,
          status: 'ready',
          message: '桌面实时通道已连接',
          currentSessionId: sessionId,
          targetSessionId: sessionId,
          sessionVerified: true
        };
      }
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: '019e-test-session',
        reason: 'mobile_button',
        mode: 'hard',
        confirmHardRestart: true
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recoveryMode, 'hard');
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, true);
    assert.equal(body.desktop.desktopLive, true);
    assert.equal(body.desktop.sessionVerified, true);
    assert.equal(body.desktop.failureClass, 'none');
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop hard recovery is blocked without explicit confirmation', async () => {
  const config = createTestConfig();
  let recovered = false;
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return { failureClass: 'none', desktopProcessMode: 'cdp', requiresDesktopCdp: false, mobileRecoverable: true };
      }
      return { failureClass: 'codex_plain_no_cdp', desktopProcessMode: 'plain', requiresDesktopCdp: true, mobileRecoverable: false };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button', mode: 'hard' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(body.desktop.recoveryAttempted, false);
    assert.equal(body.desktop.recoveryOk, false);
    assert.match(body.desktop.recoveryError, /缺少明确确认/);
  } finally {
    server.close();
  }
});

test('system repair status blocks phone hard recovery when Codex lacks CDP', async () => {
  const config = createTestConfig();
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/repair/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.system.desktop.failureClass, 'codex_plain_no_cdp');
    assert.equal(body.system.recommendedAction, 'desktop_cdp_restart_required');
    assert.equal(body.system.recoverableFromPhone, false);
    assert.equal(body.system.sessions.ok, true);
  } finally {
    server.close();
  }
});

test('system repair run does not choose hard recovery automatically for missing CDP', async () => {
  const config = createTestConfig();
  let recovered = false;
  let recoveryMode = '';
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return {
          failureClass: 'none',
          desktopProcessMode: 'cdp',
          requiresDesktopCdp: false,
          mobileRecoverable: true,
          cdpPort: 9229
        };
      }
      return {
        failureClass: 'codex_not_running',
        desktopProcessMode: 'missing',
        codexProcessCount: 0,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover(input) {
      recoveryMode = input.mode;
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      if (recovered) {
        return {
          ok: true,
          desktopLive: true,
          status: 'ready',
          message: '桌面实时通道已连接',
          currentSessionId: sessionId,
          targetSessionId: sessionId,
          sessionVerified: true
        };
      }
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'no Codex process',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/repair/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', mode: 'auto' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(recoveryMode, '');
    assert.equal(body.system.repaired, false);
    assert.equal(body.system.repairMode, 'none');
    assert.equal(body.system.hardRecoveryRequired, true);
    assert.equal(body.system.desktop.desktopLive, false);
    assert.equal(body.system.recommendedAction, 'desktop_cdp_restart_required');
  } finally {
    server.close();
  }
});

test('system link status reports HDC degradation without blocking desktop sessions', async () => {
  const config = createTestConfig();
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({
    ok: true,
    bridgeOnline: true,
    hdcActive: false,
    message: '公网 bridge 正常，无线 HDC 未配对'
  });
  config.linkHdcProbeProvider = async () => ({
    ok: false,
    proxyListening: true,
    connected: false,
    shellReady: false,
    message: 'HDC proxy 正在监听，但 hdc target 未连接'
  });
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '桌面实时通道已连接',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.link.desktop.desktopLive, true);
    assert.equal(body.link.desktop.sessionVerified, true);
    assert.equal(body.link.relay.ok, true);
    assert.equal(body.link.hdc.ok, false);
    assert.equal(body.link.severity, 'degraded');
    assert.equal(body.link.ok, true);
    assert.equal(body.link.recommendedAction, 'reconnect_hdc');
  } finally {
    server.close();
  }
});

test('system link recover refuses to auto-restart Codex when CDP requires hard recovery', async () => {
  const config = createTestConfig();
  let recovered = false;
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({ ok: true, bridgeOnline: true, message: 'relay ok' });
  config.linkHdcProbeProvider = async () => ({ ok: true, proxyListening: true, connected: true, shellReady: true, message: 'hdc ok' });
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: '普通启动态，没有 CDP',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', mode: 'auto' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(body.link.repaired, false);
    assert.equal(body.link.repairMode, 'blocked');
    assert.equal(body.link.recommendedAction, 'desktop_cdp_restart_required');
    assert.equal(body.link.recoverableFromPhone, false);
  } finally {
    server.close();
  }
});

async function waitForApproval(store, taskId) {
  for (let i = 0; i < 100; i += 1) {
    const approval = [...store.approvals.values()].find((candidate) => {
      return candidate.taskId === taskId && candidate.status === 'pending';
    });
    if (approval) {
      return approval;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for approval');
}

async function waitForTaskStatus(store, taskId, status) {
  for (let i = 0; i < 100; i += 1) {
    const task = store.getTask(taskId);
    if (task?.status === status) {
      return task;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for task status ${status}`);
}

class FakeThreadService {
  constructor() {
    this.run = null;
    this.sentMessages = [];
  }

  async listThreads() {
    return [{
      id: 'thread-1',
      title: '测试线程',
      updatedAt: new Date().toISOString(),
      detailAvailable: true
    }];
  }

  async getThread(threadId) {
    return {
      id: threadId,
      title: '测试线程',
      updatedAt: new Date().toISOString(),
      detailAvailable: true,
      filePath: '',
      entries: [],
      entryCount: 0
    };
  }

  async startThread({ prompt, model = '', reasoningEffort = '' }) {
    const thread = await this.getThread('thread-1');
    this.run = this.buildRun({ id: 'run-1', threadId: thread.id, prompt, model, reasoningEffort });
    return { thread, run: this.run };
  }

  async sendMessage({ threadId, text, model = '', reasoningEffort = '' }) {
    this.sentMessages.push({ threadId, text, model, reasoningEffort });
    this.run = this.buildRun({ id: 'run-2', threadId, prompt: text, model, reasoningEffort });
    return this.run;
  }

  getRun() {
    return this.run;
  }

  async interruptRun() {
    this.run.status = 'failed';
    return this.run;
  }

  buildRun({ id, threadId, prompt, model = '', reasoningEffort = '' }) {
    return {
      id,
      projectId: 'probe',
      prompt,
      codexSessionId: threadId,
      model,
      reasoningEffort,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      desktopSync: { status: 'app_server_official', desktopLive: false },
      session: null,
      events: [],
      eventCount: 0,
      latestEvent: null,
      error: ''
    };
  }
}

class FakeSessionVerifier {
  constructor(options = {}) {
    this.modelBySessionId = options.modelBySessionId ?? new Map();
    this.reasoningEffortBySessionId = options.reasoningEffortBySessionId ?? new Map();
  }

  async getSessionModel(sessionId) {
    return this.modelBySessionId.get(sessionId) ?? '';
  }

  async getSessionReasoningEffort(sessionId) {
    return this.reasoningEffortBySessionId.get(sessionId) ?? '';
  }

  async verifySessionTarget(sessionId, fingerprint = {}) {
    return {
      id: sessionId,
      title: fingerprint?.title ?? '测试会话',
      projectRoot: fingerprint?.projectRoot ?? 'C:\\work',
      projectLabel: fingerprint?.projectLabel ?? 'work',
      filePath: fingerprint?.filePath ?? 'C:\\sessions\\rollout.jsonl',
      entryCount: 2,
      verifiedAt: '2026-06-07T00:00:00.000Z'
    };
  }
}

class InterruptibleAdapter {
  constructor() {
    this.interrupted = null;
    this.releaseRun = null;
  }

  async run({ emit }) {
    emit('codex.app_server.thread.ready', {
      threadId: '019e-interrupt-thread'
    });
    emit('codex.app_server.turn.started', {
      turn: {
        id: 'turn-interrupt-1'
      }
    });
    await new Promise((resolve) => {
      this.releaseRun = resolve;
    });
    throw new Error('interrupted by test');
  }

  async interrupt({ task, emit }) {
    this.interrupted = {
      threadId: task.codexSessionId,
      turnId: task.activeCodexTurnId
    };
    emit('codex.app_server.turn.interrupted', this.interrupted);
    this.releaseRun?.();
    return { ok: true };
  }
}

class SlowInterruptibleAdapter extends InterruptibleAdapter {
  constructor() {
    super();
    this.interruptStarted = false;
    this.releaseInterrupt = null;
  }

  async interrupt({ task, emit }) {
    this.interruptStarted = true;
    await new Promise((resolve) => {
      this.releaseInterrupt = resolve;
    });
    return super.interrupt({ task, emit });
  }
}

class FailingInterruptAdapter extends InterruptibleAdapter {
  async interrupt() {
    throw new Error('Codex 桌面 CDP 连接错误');
  }
}

class FastAdapter {
  async run() {
    return {
      summary: 'done',
      changedFiles: [],
      tests: [],
      exitCode: 0
    };
  }

  async interrupt() {
    throw new Error('should not interrupt completed task');
  }
}

class DesktopVerifiedAdapter {
  constructor() {
    this.runs = [];
  }

  async getDesktopLiveStatus(timeoutMs, sessionId) {
    return {
      ok: true,
      desktopLive: true,
      status: 'verified',
      message: '已校验当前会话',
      currentSessionId: sessionId,
      targetSessionId: sessionId,
      sessionVerified: true
    };
  }

  async run({ task, emit }) {
    this.runs.push({
      id: task.id,
      codexSessionId: task.codexSessionId,
      prompt: task.prompt,
      model: task.model,
      reasoningEffort: task.reasoningEffort
    });
    emit('codex.desktop_sync', {
      status: 'desktop_live',
      desktopLive: true,
      mode: 'resume'
    });
    emit('codex.app_server.thread.ready', {
      threadId: task.codexSessionId,
      sessionId: task.codexSessionId
    });
    return {
      summary: 'done',
      changedFiles: [],
      tests: [],
      session: { id: task.codexSessionId, entries: [] },
      desktopSync: {
        status: 'desktop_live',
        desktopLive: true
      },
      exitCode: 0
    };
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out');
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
