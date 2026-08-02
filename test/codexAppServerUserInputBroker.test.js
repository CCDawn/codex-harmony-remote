import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexAppServerApprovalBroker } from '../src/codexAppServerApprovalBroker.js';
import { CodexAppServerUserInputBroker } from '../src/codexAppServerUserInputBroker.js';

test('user input broker exposes structured questions and returns the official answer shape', () => {
  const client = new FakeClient();
  const run = { id: 'run-1', threadId: 'thread-1', turnId: 'turn-1' };
  const broker = new CodexAppServerUserInputBroker({
    client,
    resolveRun: ({ threadId, turnId }) => (
      threadId === run.threadId && turnId === run.turnId ? run : null
    )
  });
  broker.start();

  client.emit('serverRequest', {
    id: 81,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      autoResolutionMs: 120000,
      questions: [{
        id: 'theme',
        header: '主题',
        question: '请选择默认主题',
        isOther: false,
        isSecret: false,
        options: [
          { label: '夜间', description: '黑底白字' },
          { label: '日间', description: '浅色界面' }
        ]
      }, {
        id: 'token',
        header: '密钥',
        question: '请输入临时口令',
        isOther: true,
        isSecret: true,
        options: null
      }]
    }
  });

  const pending = broker.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].questions.length, 2);
  assert.deepEqual(pending[0].questions[0].options, [
    { label: '夜间', description: '黑底白字' },
    { label: '日间', description: '浅色界面' }
  ]);
  assert.equal(pending[0].questions[1].isSecret, true);

  const answered = broker.answer(pending[0].id, {
    theme: ['夜间'],
    token: ['temporary-secret']
  });

  assert.equal(answered.status, 'answered');
  assert.deepEqual(client.responses.get(81), {
    id: 81,
    result: {
      answers: {
        theme: { answers: ['夜间'] },
        token: { answers: ['temporary-secret'] }
      }
    }
  });
  assert.equal(JSON.stringify(answered).includes('temporary-secret'), false);
  broker.stop();
});

test('user input broker validates answers and expires stale generations', () => {
  const client = new FakeClient();
  const broker = new CodexAppServerUserInputBroker({
    client,
    resolveRun: () => ({ id: 'run-1' })
  });
  broker.start();

  client.emit('serverRequest', {
    id: 82,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-2',
      questions: [{
        id: 'choice',
        header: '选择',
        question: '请选择',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: '' }]
      }]
    }
  });

  const request = broker.list()[0];
  assert.throws(() => broker.answer(request.id, {}), /Missing answer/);
  assert.throws(() => broker.answer(request.id, { choice: ['B'] }), /not an allowed option/);

  client.generation = 2;
  client.emit('reconnected', { generation: 2 });
  assert.equal(broker.get(request.id).status, 'expired');
  assert.throws(() => broker.answer(request.id, { choice: ['A'] }), /expired/);
  broker.stop();
});

test('approval broker leaves requestUserInput for the dedicated broker', () => {
  const client = new FakeClient();
  const broker = new CodexAppServerApprovalBroker({
    client,
    resolveRun: () => ({ id: 'run-1' })
  });
  broker.start();

  client.emit('serverRequest', {
    id: 83,
    method: 'item/tool/requestUserInput',
    params: { questions: [] }
  });
  assert.equal(client.responses.has(83), false);

  client.emit('serverRequest', {
    id: 84,
    method: 'item/tool/unknownRequest',
    params: {}
  });
  assert.equal(client.responses.get(84)?.error?.code, -32000);
  broker.stop();
});

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 1;
    this.responses = new Map();
  }

  health() {
    return { generation: this.generation };
  }

  respond(id, result, error = null) {
    this.responses.set(id, error ? { id, error } : { id, result });
  }
}
