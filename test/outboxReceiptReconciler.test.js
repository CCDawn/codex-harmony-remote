import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutboxReceiptReconciler } from '../src/outboxReceiptReconciler.js';

function sampleItem(overrides = {}) {
  return {
    kind: 'existing_thread',
    threadId: 'thread-a',
    projectId: 'probe',
    submissionId: 'phone-1',
    text: '远程提交内容',
    lastAttemptAt: '2026-07-29T00:00:10.000Z',
    ...overrides
  };
}

test('outbox receipt reconciler prefers an exact persisted submission receipt', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: {
      findRunBySubmission() {
        return {
          id: 'run-1',
          threadId: 'thread-a',
          submissionId: 'phone-1'
        };
      }
    },
    sessions: null
  });

  const result = await reconcile(sampleItem());
  assert.equal(result.status, 'submitted');
  assert.equal(result.result.id, 'run-1');
  assert.equal(result.evidence, 'submission_journal');
});

test('outbox receipt reconciler recognizes a matching CDP session message after dispatch began', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: null,
    sessions: {
      async getSession() {
        return {
          entries: [{
            timestamp: '2026-07-29T00:00:11.000Z',
            type: 'userMessage',
            role: 'user',
            text: '远程提交内容'
          }]
        };
      }
    }
  });

  const result = await reconcile(sampleItem());
  assert.equal(result.status, 'submitted');
  assert.equal(result.result.threadId, 'thread-a');
  assert.equal(result.evidence, 'session_user_message');
});

test('outbox receipt reconciler does not accept an older identical session message', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: null,
    sessions: {
      async getSession() {
        return {
          entries: [{
            timestamp: '2026-07-28T23:59:00.000Z',
            type: 'userMessage',
            role: 'user',
            text: '远程提交内容'
          }]
        };
      }
    }
  });

  assert.deepEqual(await reconcile(sampleItem()), {
    status: 'unknown',
    evidence: 'no_receipt'
  });
});
