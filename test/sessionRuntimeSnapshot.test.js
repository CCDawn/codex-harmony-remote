import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRuntimeSnapshotTracker } from '../src/sessionRuntimeSnapshot.js';

test('runtime snapshot keeps a newer active turn running over a terminal thread projection', () => {
  const tracker = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-a',
    now: () => '2026-07-30T09:00:00.000Z'
  });

  const snapshot = tracker.build({
    sessions: [{
      id: 'thread-1',
      title: '远程会话',
      projectLabel: 'Codex',
      runtimeState: 'completed',
      runtimeUpdatedAt: '2026-07-30T08:59:00.000Z',
      terminalReason: 'completed'
    }],
    activeRuns: [{
      threadId: 'thread-1',
      turnId: 'turn-2',
      status: 'running',
      updatedAt: '2026-07-30T09:00:00.000Z'
    }]
  });

  assert.equal(snapshot.epoch, 'epoch-a');
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.sessions[0].threadId, 'thread-1');
  assert.equal(snapshot.sessions[0].activeTurnId, 'turn-2');
  assert.equal(snapshot.sessions[0].state, 'running');
  assert.equal(snapshot.sessions[0].source, 'app-server-run');
  assert.equal(snapshot.sessions[0].terminalReason, '');
});

test('runtime snapshot preserves attention states and only advances revision when state changes', () => {
  let now = '2026-07-30T09:00:00.000Z';
  const tracker = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-b',
    now: () => now
  });
  const waiting = [{
    id: 'thread-approval',
    title: '等待批准',
    projectLabel: 'Codex',
    runtimeState: 'waiting_approval',
    runtimeUpdatedAt: '2026-07-30T08:59:50.000Z'
  }];

  const first = tracker.build({ sessions: waiting });
  now = '2026-07-30T09:00:10.000Z';
  const unchanged = tracker.build({ sessions: waiting });
  const completed = tracker.build({
    sessions: [{
      ...waiting[0],
      runtimeState: 'completed',
      runtimeUpdatedAt: '2026-07-30T09:00:09.000Z',
      terminalReason: 'completed'
    }]
  });

  assert.equal(first.sessions[0].state, 'waiting_approval');
  assert.equal(first.revision, 1);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.generatedAt, '2026-07-30T09:00:10.000Z');
  assert.equal(completed.revision, 2);
  assert.equal(completed.sessions[0].state, 'completed');
});

test('runtime snapshot uses a new epoch for a restarted tracker', () => {
  const first = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-before',
    now: () => '2026-07-30T09:00:00.000Z'
  }).build({ sessions: [] });
  const restarted = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-after',
    now: () => '2026-07-30T09:00:01.000Z'
  }).build({ sessions: [] });

  assert.equal(first.revision, 1);
  assert.equal(restarted.revision, 1);
  assert.notEqual(first.epoch, restarted.epoch);
});

test('runtime snapshot keeps a newer active turn running and records a structured decision', () => {
  const tracker = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-decisions',
    now: () => '2026-07-30T09:00:00.000Z'
  });

  const snapshot = tracker.build({
    sessions: [{
      id: 'thread-1',
      title: '远程会话',
      projectLabel: 'Codex',
      activeTurnId: 'turn-1',
      runtimeState: 'completed',
      runtimeUpdatedAt: '2026-07-30T08:59:00.000Z',
      terminalReason: 'completed'
    }],
    activeRuns: [{
      id: 'run-2',
      threadId: 'thread-1',
      turnId: 'turn-2',
      status: 'running',
      updatedAt: '2026-07-30T09:00:00.000Z',
      generation: 3
    }]
  });

  assert.equal(snapshot.sessions[0].state, 'running');
  assert.equal(snapshot.sessions[0].activeTurnId, 'turn-2');
  assert.equal(snapshot.sessions[0].canInterrupt, true);
  assert.deepEqual(snapshot.decisions, [{
    threadId: 'thread-1',
    runId: 'run-2',
    turnId: 'turn-2',
    fromState: 'completed',
    toState: 'running',
    generation: 3,
    epoch: 'epoch-decisions',
    reason: 'newer_turn_active'
  }]);
});

test('runtime snapshot keeps an official terminal state sticky for the exact same turn', () => {
  const tracker = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-sticky',
    now: () => '2026-07-30T09:00:00.000Z'
  });

  const snapshot = tracker.build({
    sessions: [{
      id: 'thread-1',
      title: '远程会话',
      projectLabel: 'Codex',
      activeTurnId: 'turn-1',
      runtimeState: 'completed',
      runtimeUpdatedAt: '2026-07-30T09:00:00.000Z',
      terminalReason: 'completed'
    }],
    activeRuns: [{
      id: 'run-stale',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'running',
      updatedAt: '2026-07-30T09:00:01.000Z',
      generation: 1
    }]
  });

  assert.equal(snapshot.sessions[0].state, 'completed');
  assert.equal(snapshot.sessions[0].activeTurnId, 'turn-1');
  assert.equal(snapshot.sessions[0].canInterrupt, false);
  assert.equal(snapshot.sessions[0].terminalReason, 'completed');
  assert.deepEqual(snapshot.decisions, [{
    threadId: 'thread-1',
    runId: 'run-stale',
    turnId: 'turn-1',
    fromState: 'completed',
    toState: 'completed',
    generation: 1,
    epoch: 'epoch-sticky',
    reason: 'official_terminal_sticky'
  }]);
});

test('desktop official runtime state overrides stale session-file inference before active bridge runs', () => {
  const tracker = new SessionRuntimeSnapshotTracker({
    epoch: 'epoch-official',
    now: () => '2026-07-30T09:00:00.000Z'
  });

  const officialIdle = tracker.build({
    sessions: [{
      id: 'thread-stale',
      title: '旧文件仍显示运行',
      runtimeState: 'running',
      runtimeSource: 'session-file',
      runtimeUpdatedAt: '2026-07-30T08:59:59.000Z'
    }],
    officialStates: [{
      threadId: 'thread-stale',
      state: 'idle',
      updatedAt: '2026-07-30T09:00:00.000Z',
      source: 'desktop-app-server'
    }]
  });
  const bridgeRun = tracker.build({
    sessions: [{
      id: 'thread-stale',
      title: '旧文件仍显示运行',
      runtimeState: 'running',
      runtimeSource: 'session-file'
    }],
    officialStates: [{
      threadId: 'thread-stale',
      state: 'idle',
      source: 'desktop-app-server'
    }],
    activeRuns: [{
      threadId: 'thread-stale',
      turnId: 'turn-phone',
      status: 'running',
      updatedAt: '2026-07-30T09:00:01.000Z'
    }]
  });

  assert.equal(officialIdle.sessions[0].state, 'idle');
  assert.equal(officialIdle.sessions[0].source, 'desktop-app-server');
  assert.equal(officialIdle.sessions[0].canInterrupt, false);
  assert.equal(bridgeRun.sessions[0].state, 'running');
  assert.equal(bridgeRun.sessions[0].source, 'app-server-run');
  assert.equal(bridgeRun.sessions[0].activeTurnId, 'turn-phone');
});
