import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexExecAdapter } from '../src/codexExecAdapter.js';

test('CodexExecAdapter builds normal exec arguments', () => {
  const adapter = new CodexExecAdapter({
    codexBin: 'codex',
    sandbox: 'workspace-write',
    approvalPolicy: 'never'
  });

  const args = adapter.buildExecArgs({
    outputPath: 'C:\\tmp\\last.txt',
    project: { root: 'C:\\work' }
  });

  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.equal(args.includes('--cd'), true);
  assert.equal(args.includes('C:\\work'), true);
  assert.equal(args.at(-1), '-');
});

test('CodexExecAdapter builds resume arguments for selected sessions', () => {
  const adapter = new CodexExecAdapter({
    codexBin: 'codex',
    sandbox: 'workspace-write',
    approvalPolicy: 'never'
  });

  const args = adapter.buildResumeArgs({
    outputPath: 'C:\\tmp\\last.txt',
    sessionId: '019e-test-session'
  });

  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', '--json']);
  assert.equal(args.includes('--cd'), false);
  assert.equal(args.includes('019e-test-session'), true);
  assert.equal(args.at(-1), '-');
});

test('CodexExecAdapter emits file-only desktop sync status before running CLI', async () => {
  const adapter = new CodexExecAdapter({
    codexBin: process.execPath,
    sandbox: 'workspace-write',
    approvalPolicy: 'never'
  });
  adapter.buildResumeArgs = () => [
    '-e',
    "process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({ type: 'thread.started', thread_id: '019e-test-session' })); });"
  ];

  const events = [];
  const result = await adapter.run({
    task: {
      id: 'task-test',
      prompt: '你好',
      codexSessionId: '019e-test-session'
    },
    project: { root: process.cwd() },
    emit: (type, payload) => {
      events.push({ type, payload });
    }
  });

  const syncEvent = events.find((event) => event.type === 'codex.desktop_sync');
  assert.equal(syncEvent.payload.desktopLive, false);
  assert.equal(syncEvent.payload.status, 'file_only');
  assert.equal(result.desktopSync.desktopLive, false);
});
