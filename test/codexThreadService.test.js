import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexThreadService } from '../src/codexThreadService.js';

test('CodexThreadService starts a thread, sends a turn, and exposes live session state', async () => {
  const client = new FakeAppServerClient();
  const desktopOpens = [];
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: true,
    desktopOpener: async (threadId) => {
      desktopOpens.push(threadId);
      return { ok: true, threadId };
    }
  });

  const result = await service.startThread({ projectId: 'probe', prompt: '你好', model: 'gpt-alt', reasoningEffort: 'xhigh' });
  assert.equal(result.run.status, 'running');
  await client.waitForRequest('turn/start');

  const running = service.getRun(result.run.id);
  assert.equal(running.status, 'running');
  await until(() => desktopOpens.length >= 1);
  assert.equal(desktopOpens[0], '019e-thread');
  const turnStartCall = client.calls.find((call) => call.method === 'turn/start');
  assert.deepEqual(turnStartCall.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turnStartCall.params.model, 'gpt-alt');
  assert.equal(turnStartCall.params.effort, 'xhigh');
  assert.equal(running.model, 'gpt-alt');
  assert.equal(running.codexSessionId, '019e-thread');
  assert.deepEqual(running.session.entries.map((entry) => `${entry.role}:${entry.text}`), [
    'user:你好'
  ]);

  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: '019e-thread',
      itemId: 'assistant-1',
      delta: '你好，'
    }
  });
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: '019e-thread',
      itemId: 'assistant-1',
      delta: '我正在处理。'
    }
  });
  const streamingSession = await service.getThread('019e-thread');
  assert.deepEqual(streamingSession.entries.map((entry) => `${entry.type}:${entry.text}`), [
    'userMessage:你好',
    'live_activity:正在返回内容'
  ]);
  assert.equal(streamingSession.entries.at(-1).liveKind, 'assistant');

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-thread',
      turn: {
        id: 'turn-1',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');
  const completed = service.getRun(result.run.id);

  assert.equal(completed.status, 'completed');
  await until(() => desktopOpens.length >= 2);
  assert.deepEqual(desktopOpens, ['019e-thread', '019e-thread']);
  assert.equal(completed.session.id, '019e-thread');
  assert.deepEqual(completed.session.entries.map((entry) => `${entry.role}:${entry.text}`), [
    'user:你好',
    'assistant:你好，我正在处理。'
  ]);
});

test('CodexThreadService does not auto-open desktop deeplinks by default', async () => {
  let opened = 0;
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    desktopOpener: async () => {
      opened += 1;
    }
  });

  const result = await service.startThread({
    cwd: process.cwd(),
    prompt: 'hello'
  });

  assert.equal(result.run.status, 'running');
  assert.equal(client.calls[0].params.cwd, 'C:\\work');
  assert.equal(opened, 0);
});

test('CodexThreadService ignores phone supplied cwd and uses configured project root for new threads', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }]
  });

  const result = await service.startThread({
    projectId: 'probe',
    cwd: pathJoinTemp('phone-supplied'),
    prompt: ''
  });

  assert.equal(result.run, null);
  assert.equal(client.calls[0].method, 'thread/start');
  assert.equal(client.calls[0].params.cwd, 'C:\\work');
});

test('CodexThreadService blocks new threads when configured project root is temporary', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: pathJoinTemp('codex-phone-bad-root') }]
  });

  await assert.rejects(
    () => service.startThread({ projectId: 'probe', prompt: '你好' }),
    /临时目录/
  );
  assert.equal(client.calls.length, 0);
});

test('CodexThreadService lists app-server threads as phone sessions', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({ client });

  const sessions = await service.listThreads({ limit: 10 });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, '019e-thread');
  assert.equal(sessions[0].title, '测试会话');
  assert.equal(sessions[0].detailAvailable, true);
});

test('CodexThreadService prefers desktop sidebar sessions when available', async () => {
  const client = new FakeAppServerClient();
  const desktopSessions = [{
    id: '019e-desktop-thread',
    title: '桌面侧栏会话',
    updatedAt: '2026-05-29T08:00:00.000Z',
    relativeTime: '1 小时前',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'desktop-sidebar',
    activitySource: 'session-file',
    pinned: false,
    detailAvailable: true
  }];
  const sessions = {
    async listSessions({ limit, query }) {
      assert.equal(limit, 10);
      assert.equal(query, '');
      return desktopSessions;
    }
  };
  const service = new CodexThreadService({ client, sessions });

  const listed = await service.listThreads({ limit: 10 });

  assert.deepEqual(listed, desktopSessions);
  assert.equal(client.calls.some((call) => call.method === 'thread/list'), false);
});

test('CodexThreadService preserves desktop running status when live snapshot is idle', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-thread',
        title: '设置',
        updatedAt: '2026-05-30T08:24:09.016Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-05-30T08:24:09.016Z',
        pinned: false,
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '设置',
    updatedAt: '2026-05-30T08:24:10.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    activitySource: 'app-server-live',
    activityStatus: 'idle',
    activityUpdatedAt: '',
    detailAvailable: true,
    entries: [],
    entryCount: 0
  });

  const listed = await service.listThreads({ limit: 10 });

  assert.equal(listed[0].id, '019e-thread');
  assert.equal(listed[0].activityStatus, 'running');
  assert.equal(listed[0].activityUpdatedAt, '2026-05-30T08:24:09.016Z');
});

test('CodexThreadService reads existing thread detail from local rollout before stale app-server snapshot', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async getSession(threadId, { tail }) {
      assert.equal(threadId, '019e-thread');
      assert.equal(String(tail), '160');
      return {
        id: threadId,
        title: '测试会话',
        updatedAt: '2026-05-29T16:33:14.018Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        detailAvailable: true,
        filePath: 'C:\\Users\\agent\\.codex\\sessions\\rollout.jsonl',
        entries: [{
          timestamp: '2026-05-29T16:33:02.593Z',
          type: 'response_item',
          role: 'user',
          text: '手机发给你的消息，看看正确进入对话了吗'
        }, {
          timestamp: '2026-05-29T16:33:14.018Z',
          type: 'event_msg',
          role: 'assistant',
          text: '我来按日志链路查，不靠猜'
        }],
        entryCount: 2
      };
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '测试会话',
    updatedAt: '2026-05-29T16:28:28.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    detailAvailable: true,
    entries: [{
      timestamp: '2026-05-29T16:28:28.000Z',
      type: 'agentMessage',
      role: 'assistant',
      text: '旧快照'
    }],
    entryCount: 1
  });

  const detail = await service.getThread('019e-thread', { tail: 160 });

  assert.equal(detail.source, 'desktop-sidebar');
  assert.deepEqual(detail.entries.map((entry) => entry.text), [
    '手机发给你的消息，看看正确进入对话了吗',
    '我来按日志链路查，不靠猜'
  ]);
  assert.equal(client.calls.some((call) => call.method === 'thread/read'), false);
});

test('CodexThreadService accepts nested app-server notification ids and generic reasoning deltas', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: false
  });

  const result = await service.startThread({ projectId: 'probe', prompt: '分析一下' });
  await client.waitForRequest('turn/start');

  client.emit('notification', {
    method: 'item/started',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        threadId: '019e-thread',
        turnId: 'turn-1'
      }
    }
  });
  client.emit('notification', {
    method: 'item/delta',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        thread_id: '019e-thread',
        turn_id: 'turn-1'
      },
      delta: {
        text: '正在检查日志'
      }
    }
  });

  const streamingSession = await service.getThread('019e-thread');
  assert.deepEqual(streamingSession.entries.map((entry) => `${entry.type}:${entry.text}`), [
    'userMessage:分析一下',
    'live_activity:正在思考'
  ]);
  assert.equal(streamingSession.entries.at(-1).liveKind, 'reasoning');

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      turn: {
        id: 'turn-1',
        thread_id: '019e-thread',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');
  assert.equal(service.getRun(result.run.id).status, 'completed');
});

test('CodexThreadService keeps one bottom live activity while work changes from reasoning to command output', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: false
  });

  await service.startThread({ projectId: 'probe', prompt: '继续修复' });
  await client.waitForRequest('turn/start');

  client.emit('notification', {
    method: 'item/delta',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        threadId: '019e-thread',
        turnId: 'turn-1'
      },
      delta: {
        text: '定位状态入口'
      }
    }
  });
  client.emit('notification', {
    method: 'item/started',
    params: {
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'npm test -- test/codexThreadService.test.js',
        threadId: '019e-thread',
        turnId: 'turn-1'
      }
    }
  });
  client.emit('notification', {
    method: 'item/commandExecution/outputDelta',
    params: {
      itemId: 'command-1',
      threadId: '019e-thread',
      turnId: 'turn-1',
      delta: 'ok 1 - live activity'
    }
  });

  const streamingSession = await service.getThread('019e-thread');
  const liveEntries = streamingSession.entries.filter((entry) => entry.type === 'live_activity');
  assert.equal(liveEntries.length, 1);
  assert.equal(streamingSession.entries.at(-1), liveEntries[0]);
  assert.equal(liveEntries[0].liveKind, 'command');
  assert.equal(liveEntries[0].text, '正在执行命令');
});

test('CodexThreadService blocks deleting a running thread and clears local snapshots after deletion', async () => {
  const client = new FakeAppServerClient();
  const deleted = [];
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    sessions: {
      async deleteSession(threadId) {
        deleted.push(threadId);
        return {
          id: threadId,
          deletedFiles: ['C:\\Users\\agent\\.codex\\sessions\\rollout-019e-thread.jsonl'],
          archivedThreadCount: 1,
          removedIndexRecords: 1,
          removedGlobalStateEntries: 0,
          deletedAt: '2026-06-08T00:00:00.000Z'
        };
      }
    }
  });

  const result = await service.startThread({ prompt: '运行中' });
  await client.waitForRequest('turn/start');
  await assert.rejects(
    () => service.deleteThread('019e-thread'),
    /会话正在进行中/
  );
  assert.deepEqual(deleted, []);

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-thread',
      turn: {
        id: 'turn-1',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');

  const deletion = await service.deleteThread('019e-thread');
  assert.equal(deletion.archivedThreadCount, 1);
  assert.deepEqual(deleted, ['019e-thread']);
  assert.equal(service.liveSessions.has('019e-thread'), false);
});

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.waiters = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    this.resolveWaiters(method);
    if (method === 'thread/list') {
      return {
        data: [{
          id: '019e-thread',
          name: '测试会话',
          cwd: 'C:\\work',
          updatedAt: 1779926401
        }]
      };
    }
    if (method === 'thread/start') {
      return {
        thread: {
          id: '019e-thread',
          name: '',
          cwd: params.cwd,
          updatedAt: 1779926400,
          turns: []
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          cwd: 'C:\\work',
          turns: []
        }
      };
    }
    if (method === 'turn/start') {
      return {
        turn: {
          id: 'turn-1',
          status: 'inProgress'
        }
      };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          name: '测试会话',
          cwd: 'C:\\work',
          updatedAt: 1779926401,
          turns: [{
            id: 'turn-1',
            status: 'completed',
            startedAt: 1779926400,
            completedAt: 1779926401,
            items: [{
              type: 'userMessage',
              id: 'user-1',
              content: [{ type: 'text', text: '你好', text_elements: [] }]
            }, {
              type: 'agentMessage',
              id: 'assistant-1',
              text: '你好，我正在处理。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }

  waitForRequest(method) {
    if (this.calls.some((call) => call.method === method)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ method, resolve });
    });
  }

  resolveWaiters(method) {
    const ready = this.waiters.filter((waiter) => waiter.method === method);
    this.waiters = this.waiters.filter((waiter) => waiter.method !== method);
    ready.forEach((waiter) => waiter.resolve());
  }
}

async function until(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

function pathJoinTemp(child) {
  return path.join(os.tmpdir(), child);
}


