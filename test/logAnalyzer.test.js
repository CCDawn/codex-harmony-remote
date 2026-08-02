import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeLogRun } from '../src/logAnalyzer.js';

test('analyzeLogRun writes summary files and highlights important events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-analysis-'));
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ runId: 'run_test', label: 'test' }), 'utf8');
  await fs.writeFile(path.join(root, 'all.jsonl'), [
    JSON.stringify({ timestamp: '2026-05-28T00:00:00.000Z', source: 'bridge', level: 'info', event: 'http.request.completed', data: { statusCode: 200 } }),
    JSON.stringify({ timestamp: '2026-05-28T00:00:01.000Z', source: 'harmony-app', level: 'error', event: 'action.failed', data: { message: 'boom' } }),
    ''
  ].join('\n'), 'utf8');

  const summary = await analyzeLogRun(root);

  assert.equal(summary.health.status, 'needs_attention');
  assert.equal(summary.app.entries, 1);
  assert.equal(summary.important.length, 1);
  assert.match(await fs.readFile(path.join(root, 'summary.md'), 'utf8'), /action\.failed/);
  assert.match(await fs.readFile(path.join(root, 'summary.json'), 'utf8'), /needs_attention/);
});

test('analyzeLogRun correlates interrupt, queued follow-up, policy, model, and runtime state diagnostics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-state-sync-analysis-'));
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ runId: 'run_state_sync', label: 'state-sync' }), 'utf8');
  const entries = [
    { timestamp: '2026-08-02T00:00:00.000Z', source: 'bridge', level: 'info', event: 'codex.turn.interrupt.requested', data: { runId: 'run-1', threadId: 'thread-1', payload: { turnId: 'turn-1' } } },
    { timestamp: '2026-08-02T00:00:01.000Z', source: 'bridge', level: 'info', event: 'submission.blocked_by_interrupt', data: { id: 'outbox-1', submissionId: 'phone-1', threadId: 'thread-1', runId: 'run-1', turnId: 'turn-1' } },
    { timestamp: '2026-08-02T00:00:02.000Z', source: 'bridge', level: 'info', event: 'codex.turn.interrupt.confirmed', data: { runId: 'run-1', threadId: 'thread-1', payload: { turnId: 'turn-1', terminalStatus: 'interrupted' } } },
    { timestamp: '2026-08-02T00:00:03.000Z', source: 'bridge', level: 'info', event: 'submission.dequeued', data: { id: 'outbox-1', submissionId: 'phone-1', threadId: 'thread-1', previousReason: 'interrupt_pending' } },
    { timestamp: '2026-08-02T00:00:04.000Z', source: 'bridge', level: 'info', event: 'outbox.item.submitted', data: { id: 'outbox-1', submissionId: 'phone-1', threadId: 'thread-1', resultId: 'run-2' } },
    { timestamp: '2026-08-02T00:00:05.000Z', source: 'bridge', level: 'info', event: 'policy.effective', data: { sandbox: 'danger-full-access', approvalPolicy: 'never' } },
    { timestamp: '2026-08-02T00:00:06.000Z', source: 'bridge', level: 'warn', event: 'policy.mismatch', data: { runId: 'run-2', threadId: 'thread-1', turnId: 'turn-2' } },
    { timestamp: '2026-08-02T00:00:07.000Z', source: 'bridge', level: 'info', event: 'model.catalog.loaded', data: { source: 'app_server', revision: 'gpt-sol|gpt-terra', modelCount: 2, defaultModel: 'gpt-sol' } },
    { timestamp: '2026-08-02T00:00:08.000Z', source: 'bridge', level: 'info', event: 'runtime.snapshot.reconciled', data: { revision: 4, conflictCount: 1, decisions: [{ threadId: 'thread-1', turnId: 'turn-1', reason: 'official_terminal_sticky' }] } },
    { timestamp: '2026-08-02T00:00:08.500Z', source: 'bridge', level: 'info', event: 'runtime.snapshot.app_server_projected', data: { source: 'thread/list', resolvedThreadIds: ['thread-1'], activeThreadIds: [], unresolvedActiveThreadIds: [] } },
    { timestamp: '2026-08-02T00:00:09.000Z', source: 'bridge', level: 'info', event: 'codex.turn.interrupt.requested', data: { runId: 'run-stuck', threadId: 'thread-2', payload: { turnId: 'turn-stuck' } } }
  ];
  await fs.writeFile(
    path.join(root, 'all.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );

  const summary = await analyzeLogRun(root);

  assert.equal(summary.stateSync.interrupts.requested, 2);
  assert.equal(summary.stateSync.interrupts.confirmed, 1);
  assert.equal(summary.stateSync.interrupts.unresolved.length, 1);
  assert.equal(summary.stateSync.submissions.blockedByInterrupt, 1);
  assert.equal(summary.stateSync.submissions.released, 1);
  assert.equal(summary.stateSync.submissions.submitted, 1);
  assert.equal(summary.stateSync.submissions.stuck.length, 0);
  assert.equal(summary.stateSync.policy.mismatches.length, 1);
  assert.equal(summary.stateSync.modelCatalog.source, 'app_server');
  assert.equal(summary.stateSync.runtime.conflicts, 1);
  assert.equal(summary.stateSync.runtime.projections, 1);
  assert.deepEqual(summary.stateSync.runtime.latestProjection.resolvedThreadIds, ['thread-1']);
  assert.deepEqual(
    summary.stateSync.anomalies.map((item) => item.code).sort(),
    ['interrupt_without_terminal', 'policy_mismatch']
  );
  assert.match(await fs.readFile(path.join(root, 'summary.md'), 'utf8'), /## State Sync/);
  assert.match(await fs.readFile(path.join(root, 'summary.md'), 'utf8'), /interrupt_without_terminal/);
});
