import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAppServerApprovalBroker } from '../src/codexAppServerApprovalBroker.js';
import { CodexAppServerRunJournal } from '../src/codexAppServerRunJournal.js';
import { CodexThreadService } from '../src/codexThreadService.js';

const THREAD_1 = '019e0000-0000-7000-8000-000000000001';
const TURN_1 = '019e0000-0000-7000-8000-000000000002';
const TURN_2 = '019e0000-0000-7000-8000-000000000003';

test('run journal persists only recoverable run metadata and never the prompt or command bodies', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-runs-'));
  const filePath = path.join(directory, 'runs.json');
  const journal = new CodexAppServerRunJournal({ filePath, epoch: 'epoch-journal' });

  journal.persist([{
    id: 'run-1',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    prompt: '这段提示绝不能写进恢复状态',
    command: 'Write-Output secret-command-body',
    submissionId: 'submission-1',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    model: 'gpt-test',
    reasoningEffort: 'high',
    generation: 7
  }, {
    id: 'run-finished',
    threadId: THREAD_1,
    turnId: TURN_2,
    status: 'completed'
  }]);

  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(persisted, /这段提示绝不能写进恢复状态/);
  assert.doesNotMatch(persisted, /secret-command-body/);
  const parsed = JSON.parse(persisted);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.epoch, 'epoch-journal');
  assert.equal(typeof parsed.journalId, 'string');
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].threadId, THREAD_1);
  assert.equal(parsed.runs[0].turnId, TURN_1);
  assert.equal(parsed.runs[0].status, 'running');
  assert.deepEqual(journal.load(), [{
    id: 'run-1',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    submissionId: 'submission-1',
    status: 'recovering',
    lastKnownStatus: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    model: 'gpt-test',
    reasoningEffort: 'high',
    prompt: '',
    promptLength: 13,
    createdThreadId: null,
    deliveryMode: 'app_server',
    generation: 7
  }]);
});

test('run journal never persists synthetic probe identifiers and requires Codex-shaped UUIDs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-runs-'));
  const filePath = path.join(directory, 'runs.json');
  const journal = new CodexAppServerRunJournal({ filePath });

  journal.persist([{
    id: 'probe-1',
    threadId: '019e-thread',
    turnId: TURN_1,
    status: 'running'
  }, {
    id: 'probe-2',
    threadId: THREAD_1,
    turnId: 'turn-1',
    status: 'running'
  }, {
    id: 'probe-3',
    threadId: THREAD_1,
    turnId: '',
    status: 'running'
  }, {
    id: 'probe-4',
    threadId: 'not-a-uuid',
    turnId: 'also-not-a-uuid',
    status: 'running'
  }, {
    id: 'run-valid',
    threadId: THREAD_1,
    turnId: TURN_1,
    status: 'running'
  }]);

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].id, 'run-valid');
  assert.deepEqual(journal.load().map((entry) => entry.id), ['run-valid']);

  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    runs: [{
      id: 'handwritten-probe',
      threadId: '019e-thread',
      turnId: 'turn-1',
      status: 'running'
    }]
  }));
  assert.deepEqual(journal.load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('run journal loads legacy schemas forward and refuses unknown future schemas', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-runs-'));
  const filePath = path.join(directory, 'runs.json');
  const journal = new CodexAppServerRunJournal({ filePath });

  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    runs: [{
      id: 'legacy-run',
      threadId: THREAD_1,
      turnId: TURN_1,
      status: 'running',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:01.000Z'
    }]
  }));
  const loaded = journal.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'legacy-run');
  assert.equal(loaded[0].status, 'recovering');
  assert.equal(loaded[0].lastKnownStatus, 'running');

  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 99,
    runs: [{
      id: 'future-run',
      threadId: THREAD_1,
      turnId: TURN_1,
      status: 'running'
    }]
  }));
  assert.deepEqual(journal.load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('approval broker accepts only the current app-server generation and expires stale prompts', async () => {
  const client = new FakeRuntimeClient();
  const run = { id: 'run-1', threadId: 'thr-1', turnId: 'turn-1' };
  const broker = new CodexAppServerApprovalBroker({
    client,
    resolveRun: ({ threadId, turnId }) => threadId === run.threadId && turnId === run.turnId ? run : null
  });
  broker.start();

  client.emit('serverRequest', {
    id: 701,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thr-1',
      turnId: 'turn-1',
      command: 'Write-Output safe',
      reason: 'protocol test'
    }
  });
  await until(() => broker.list().length === 1);
  const first = broker.list()[0];
  assert.equal(first.status, 'pending');
  assert.equal(first.generation, 1);

  broker.decide(first.id, 'approved');
  assert.deepEqual(client.responses.get(701), {
    id: 701,
    result: { decision: 'accept' }
  });

  client.emit('serverRequest', {
    id: 702,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr-1', turnId: 'turn-1', command: 'Write-Output stale' }
  });
  await until(() => broker.list().length === 2);
  const stale = broker.list()[1];
  client.generation = 2;
  client.emit('reconnected', { generation: 2 });

  assert.equal(broker.get(stale.id).status, 'expired');
  assert.throws(() => broker.decide(stale.id, 'approved'), /expired/);
  broker.stop();
});

test('thread service deduplicates a repeated submission before starting a second turn', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  const first = await service.sendMessage({
    threadId: 'thr-1',
    text: '只提交一次',
    projectId: 'project-1',
    submissionId: 'submission-1'
  });
  const second = await service.sendMessage({
    threadId: 'thr-1',
    text: '只提交一次',
    projectId: 'project-1',
    submissionId: 'submission-1'
  });

  await until(() => client.calls.filter((call) => call.method === 'turn/start').length === 1);
  assert.equal(first.id, second.id);
  assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(service.getRun(first.id).runtime.kind, 'app_server');
});

test('thread service marks a desktop-primary fallback without claiming desktop live sync', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  const run = await service.sendMessage({
    threadId: 'thr-desktop-primary',
    text: '桌面暂不可用时的兜底消息',
    projectId: 'project-1',
    submissionId: 'desktop-primary-fallback-1',
    deliveryMode: 'desktop_fallback',
    fallbackReason: 'desktop live unavailable'
  });

  assert.equal(run.desktopSync.status, 'app_server_fallback');
  assert.equal(run.desktopSync.desktopLive, false);
  assert.match(run.desktopSync.message, /兜底/);
  assert.equal(run.events.some((event) => event.type === 'codex.desktop_sync' && event.payload.status === 'app_server_fallback'), true);
});

test('thread service retries a failed pre-turn submission with the same submission id', async () => {
  const client = new FakeRuntimeClient();
  client.failNextTurnStart = true;
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  const first = await service.sendMessage({
    threadId: 'thr-1',
    text: '失败后允许重试',
    projectId: 'project-1',
    submissionId: 'retry-after-pre-turn-failure'
  });
  await until(() => service.getRun(first.id).status === 'failed');

  const retry = await service.sendMessage({
    threadId: 'thr-1',
    text: '失败后允许重试',
    projectId: 'project-1',
    submissionId: 'retry-after-pre-turn-failure'
  });

  await until(() => client.calls.filter((call) => call.method === 'turn/start').length === 2);
  assert.notEqual(retry.id, first.id);
  assert.equal(service.getRun(retry.id).status, 'running');
});

test('thread service deduplicates a retried new-thread submission before creating a second thread', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  const first = await service.startThread({
    projectId: 'project-1',
    prompt: '新会话也只能创建一次',
    submissionId: 'new-thread-submission-1'
  });
  const second = await service.startThread({
    projectId: 'project-1',
    prompt: '新会话也只能创建一次',
    submissionId: 'new-thread-submission-1'
  });

  assert.equal(first.run.id, second.run.id);
  assert.equal(first.thread.id, second.thread.id);
  assert.equal(client.calls.filter((call) => call.method === 'thread/start').length, 1);
});

test('thread service turns a protocol approval into the existing mobile approval contract', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });
  const run = await service.sendMessage({
    threadId: 'thr-1',
    text: '等待审批',
    projectId: 'project-1',
    submissionId: 'submission-approval'
  });
  await until(() => service.getRun(run.id).activeCodexTurnId === 'turn-1');

  client.emit('serverRequest', {
    id: 703,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thr-1',
      turnId: 'turn-1',
      command: 'Write-Output approved',
      reason: 'test command'
    }
  });
  await until(() => service.listApprovals().length === 1);
  const approval = service.listApprovals()[0];
  assert.equal(service.getRun(run.id).status, 'waiting_approval');

  const decided = service.decideApproval(approval.id, 'approved');
  assert.equal(decided.decision, 'approved');
  assert.equal(service.getRun(run.id).status, 'running');
  assert.deepEqual(client.responses.get(703), {
    id: 703,
    result: { decision: 'accept' }
  });
});

test('thread service exposes requestUserInput as a waiting mobile form without leaking answers', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });
  const run = await service.sendMessage({
    threadId: 'thr-1',
    text: '需要用户回答',
    projectId: 'project-1',
    submissionId: 'submission-user-input'
  });
  await until(() => service.getRun(run.id).activeCodexTurnId === 'turn-1');

  client.emit('serverRequest', {
    id: 704,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thr-1',
      turnId: 'turn-1',
      itemId: 'item-input-1',
      questions: [{
        id: 'confirm',
        header: '确认',
        question: '是否继续？',
        isOther: false,
        isSecret: false,
        options: [
          { label: '继续', description: '继续执行' },
          { label: '停止', description: '停止执行' }
        ]
      }]
    }
  });
  await until(() => service.listUserInputs().length === 1);
  const request = service.listUserInputs()[0];
  assert.equal(service.getRun(run.id).status, 'waiting_input');
  assert.equal(service.getRun(run.id).pendingUserInput?.id, request.id);

  const answered = service.answerUserInput(request.id, { confirm: ['继续'] });
  assert.equal(answered.status, 'answered');
  assert.equal(service.getRun(run.id).status, 'running');
  assert.deepEqual(client.responses.get(704), {
    id: 704,
    result: { answers: { confirm: { answers: ['继续'] } } }
  });
  assert.equal(JSON.stringify(service.getRun(run.id).events).includes('"answers"'), false);
});

test('thread service confirms an App Server interrupt as interrupted instead of treating it as a generic failure', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });
  const run = await service.sendMessage({
    threadId: 'thr-1',
    text: '需要中断',
    projectId: 'project-1',
    submissionId: 'submission-interrupt'
  });
  await until(() => service.getRun(run.id).activeCodexTurnId === 'turn-1');

  const interrupted = await service.interruptRun(run.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.equal(interrupted.runtime.canInterrupt, false);
});

test('thread service resolves a primary-session interrupt to its active App Server run', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });
  const run = await service.sendMessage({
    threadId: 'thr-primary',
    text: '按会话中断',
    projectId: 'project-1',
    submissionId: 'submission-primary-interrupt'
  });
  await until(() => service.getRun(run.id).activeCodexTurnId === 'turn-1');

  const interrupted = await service.interruptThread('thr-primary');

  assert.equal(interrupted.id, run.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
});

test('thread service can eagerly initialize the managed App Server before the first phone send', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  const health = await service.initialize();

  assert.equal(client.initializeCalls, 1);
  assert.equal(health.kind, 'app_server');
  assert.equal(health.state, 'ready');
});

test('thread service restores a persisted active turn during the first App Server initialization', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-recovery-'));
  const runStatePath = path.join(directory, 'runs.json');
  new CodexAppServerRunJournal({ filePath: runStatePath }).persist([{
    id: 'run-recover',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    submissionId: 'submission-recover',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    model: 'gpt-test',
    reasoningEffort: 'high',
    generation: 1
  }]);
  const client = new FakeRuntimeClient();
  client.threadReadTurns = [{ id: TURN_1, status: 'inProgress' }];
  const service = new CodexThreadService({
    client,
    runStatePath,
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  assert.equal(service.getRun('run-recover').status, 'recovering');
  await service.initialize();

  assert.equal(service.getRun('run-recover').status, 'running');
  assert.equal(service.getRun('run-recover').runtime.canInterrupt, true);
  assert.equal(client.calls.filter((call) => call.method === 'thread/read').length, 1);
  const recoveredEvent = service.getRun('run-recover').events
    .find((event) => event.type === 'codex.run.recovered');
  assert.equal(recoveredEvent.payload.reason, 'verified_active');
  assert.equal(recoveredEvent.payload.runId, 'run-recover');
  assert.equal(recoveredEvent.payload.threadId, THREAD_1);
  assert.equal(recoveredEvent.payload.turnId, TURN_1);
  assert.equal(recoveredEvent.payload.fromStatus, 'recovering');
  assert.equal(recoveredEvent.payload.toStatus, 'running');
  assert.equal(recoveredEvent.payload.generation, 1);
  assert.equal(recoveredEvent.payload.epoch, service.runtimeSnapshotTracker.epoch);
  assert.deepEqual(new CodexAppServerRunJournal({ filePath: runStatePath }).load().map((entry) => entry.id), ['run-recover']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persisted run for the same exact turn cannot override an official terminal state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-sticky-'));
  const runStatePath = path.join(directory, 'runs.json');
  new CodexAppServerRunJournal({ filePath: runStatePath }).persist([{
    id: 'run-sticky',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    submissionId: 'submission-sticky',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    model: 'gpt-test',
    reasoningEffort: 'high',
    generation: 1
  }]);
  const client = new FakeRuntimeClient();
  client.threadReadTurns = [{ id: TURN_1, status: 'completed' }];
  const service = new CodexThreadService({
    client,
    runStatePath,
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  await service.initialize();

  const run = service.getRun('run-sticky');
  assert.equal(run.status, 'completed');
  assert.equal(run.runtime.canInterrupt, false);
  assert.equal(run.interruptReady, false);
  const interrupted = await service.interruptRun('run-sticky');
  assert.equal(interrupted.status, 'completed');
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  const terminalEvent = run.events.find((event) => event.type === 'codex.run.recovered_terminal');
  assert.deepEqual(terminalEvent.payload, {
    runId: 'run-sticky',
    threadId: THREAD_1,
    turnId: TURN_1,
    fromStatus: 'recovering',
    toStatus: 'completed',
    reason: 'official_terminal_sticky',
    generation: 1,
    epoch: service.runtimeSnapshotTracker.epoch
  });
  assert.deepEqual(new CodexAppServerRunJournal({ filePath: runStatePath }).load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persisted run for a missing exact turn settles as interrupted and is never persisted again', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-missing-'));
  const runStatePath = path.join(directory, 'runs.json');
  new CodexAppServerRunJournal({ filePath: runStatePath }).persist([{
    id: 'run-missing',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    generation: 1
  }]);
  const client = new FakeRuntimeClient();
  client.threadReadTurns = [{ id: TURN_2, status: 'completed' }];
  const service = new CodexThreadService({
    client,
    runStatePath,
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  await service.initialize();

  const run = service.getRun('run-missing');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.runtime.canInterrupt, false);
  const interrupted = await service.interruptRun('run-missing');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  const terminalEvent = run.events.find((event) => event.type === 'codex.run.recovered_terminal');
  assert.equal(terminalEvent.payload.reason, 'turn_not_found');
  assert.equal(terminalEvent.payload.fromStatus, 'recovering');
  assert.equal(terminalEvent.payload.toStatus, 'interrupted');
  assert.equal(terminalEvent.payload.runId, 'run-missing');
  assert.equal(terminalEvent.payload.threadId, THREAD_1);
  assert.equal(terminalEvent.payload.turnId, TURN_1);
  assert.deepEqual(new CodexAppServerRunJournal({ filePath: runStatePath }).load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persisted run is superseded while a genuinely newer turn stays active', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-supersede-'));
  const runStatePath = path.join(directory, 'runs.json');
  new CodexAppServerRunJournal({ filePath: runStatePath }).persist([{
    id: 'run-old',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    generation: 1
  }]);
  const client = new FakeRuntimeClient();
  client.threadReadTurns = [{ id: TURN_2, status: 'inProgress' }];
  const service = new CodexThreadService({
    client,
    runStatePath,
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  await service.initialize();

  const run = service.getRun('run-old');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.runtime.canInterrupt, false);
  const terminalEvent = run.events.find((event) => event.type === 'codex.run.recovered_terminal');
  assert.equal(terminalEvent.payload.reason, 'superseded_by_newer_turn');
  assert.equal(terminalEvent.payload.toStatus, 'interrupted');
  assert.equal(service.activeRunsByThreadId.has(THREAD_1), false);
  assert.ok(service.liveSessions.get(THREAD_1));
  assert.deepEqual(new CodexAppServerRunJournal({ filePath: runStatePath }).load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('thread/read failure during recovery fails closed and is not persisted again', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-read-fail-'));
  const runStatePath = path.join(directory, 'runs.json');
  new CodexAppServerRunJournal({ filePath: runStatePath }).persist([{
    id: 'run-read-fail',
    threadId: THREAD_1,
    turnId: TURN_1,
    projectId: 'project-1',
    status: 'running',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    generation: 1
  }]);
  const client = new FakeRuntimeClient();
  client.threadReadError = new Error('app server unreachable');
  const service = new CodexThreadService({
    client,
    runStatePath,
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  await service.initialize();

  const run = service.getRun('run-read-fail');
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'app server unreachable');
  assert.equal(run.runtime.canInterrupt, false);
  const interrupted = await service.interruptRun('run-read-fail');
  assert.equal(interrupted.status, 'failed');
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  const failedEvent = run.events.find((event) => event.type === 'codex.run.recovery_failed');
  assert.equal(failedEvent.payload.reason, 'thread_read_failed');
  assert.equal(failedEvent.payload.runId, 'run-read-fail');
  assert.equal(failedEvent.payload.threadId, THREAD_1);
  assert.equal(failedEvent.payload.turnId, TURN_1);
  assert.equal(failedEvent.payload.fromStatus, 'recovering');
  assert.equal(failedEvent.payload.toStatus, 'failed');
  assert.equal(failedEvent.payload.message, 'app server unreachable');
  assert.equal(failedEvent.payload.epoch, service.runtimeSnapshotTracker.epoch);
  assert.deepEqual(new CodexAppServerRunJournal({ filePath: runStatePath }).load(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('thread lifecycle uses the App Server sandbox spelling and identifies the Bridge service', async () => {
  const client = new FakeRuntimeClient();
  const service = new CodexThreadService({
    client,
    runStatePath: '',
    projects: [{ id: 'project-1', name: 'Project', root: 'C:\\work' }]
  });

  await service.startThread({
    projectId: 'project-1',
    prompt: '验证协议字段',
    submissionId: 'sandbox-spelling'
  });
  await until(() => client.calls.some((call) => call.method === 'turn/start'));

  const started = client.calls.find((call) => call.method === 'thread/start');
  const resumed = client.calls.find((call) => call.method === 'thread/resume');
  assert.equal(started.params.sandbox, 'workspace-write');
  assert.equal(started.params.serviceName, 'codex_harmony_remote');
  assert.equal(resumed.params.sandbox, 'workspace-write');
});

class FakeRuntimeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 1;
    this.calls = [];
    this.responses = new Map();
    this.initializeCalls = 0;
    this.failNextTurnStart = false;
    this.threadReadTurns = [{ id: 'turn-1', status: 'inProgress' }];
    this.threadReadError = null;
  }

  async initialize() {
    this.initializeCalls += 1;
    return { generation: this.generation };
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      return { thread: { id: 'thr-new', cwd: 'C:\\work', turns: [] } };
    }
    if (method === 'thread/resume') {
      return { thread: { id: params.threadId, cwd: 'C:\\work', turns: [] } };
    }
    if (method === 'turn/start') {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error('pre-turn protocol failure');
      }
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: { id: params.turnId, status: 'interrupted' }
        }
      }));
      return {};
    }
    if (method === 'thread/read') {
      if (this.threadReadError) {
        throw this.threadReadError;
      }
      return {
        thread: {
          id: params.threadId,
          cwd: 'C:\\work',
          turns: this.threadReadTurns
        }
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  respond(id, result) {
    this.responses.set(id, { id, result });
  }

  health() {
    return { state: 'ready', generation: this.generation, pendingRequests: 0 };
  }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for runtime state');
}
