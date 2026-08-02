import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';

function fingerprint() {
  return {
    title: '持久队列测试',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    filePath: 'C:\\sessions\\thread-a.jsonl',
    entryCount: 2
  };
}

async function createFixture({ outboxPath, runs = [], onSend = null, threadServiceOverrides = {} }) {
  const threadService = {
    async listProjects() {
      return [{ id: 'probe', name: 'Probe', root: 'C:\\work' }];
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      return { id: 'thread-a', title: '持久队列测试', entries: [], activityStatus: 'idle' };
    },
    listRuns() {
      return runs;
    },
    getRun(id) {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) {
        const error = new Error('Unknown run');
        error.statusCode = 404;
        throw error;
      }
      return run;
    },
    async sendMessage(input) {
      if (onSend) {
        return await onSend(input);
      }
      const run = {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
      runs.push(run);
      return run;
    },
    runtimeHealth() {
      return { kind: 'app_server', enabled: true, state: 'ready' };
    },
    listApprovals() {
      return [];
    },
    ...threadServiceOverrides
  };
  const config = {
    repoRoot: path.dirname(outboxPath),
    outboxPath,
    outboxEnabled: true,
    outboxBlockedDelayMs: 250,
    appServerRuntimeMode: 'app-server-primary',
    threadService,
    sessions: {
      async verifySessionTarget(id) {
        return { id, ...fingerprint() };
      }
    },
    sessionSettings: {
      async getSessionSettings() {
        return { model: '', reasoningEffort: '' };
      },
      async updateSessionSettings() {
        return { model: '', reasoningEffort: '' };
      },
      async deleteSessionSettings() {
      }
    },
    defaultReasoningEffortProvider: async () => '',
    codexSettingsProvider: async () => ({ model: '', reasoningEffort: '', models: [] }),
    desktopLiveDiagnostics: false,
    logger: new DiagnosticLogger({
      root: path.join(os.tmpdir(), `codex-outbox-api-logs-${Date.now()}-${Math.random()}`)
    }),
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work', allowedCommands: [] }]
  };
  const app = createApp({ config, adapter: { async run() { return {}; } } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    runs
  };
}

async function send(baseUrl, submissionId, text = '持久消息') {
  return await fetch(`${baseUrl}/api/codex/threads/thread-a/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'probe',
      text,
      submissionId,
      sessionFingerprint: fingerprint()
    })
  });
}

test('thread message outbox deduplicates the same submission after bridge restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-api-'));
  const outboxPath = path.join(root, 'outbox.json');
  let firstDispatches = 0;
  const first = await createFixture({
    outboxPath,
    onSend: async (input) => {
      firstDispatches += 1;
      return {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
    }
  });
  try {
    const response = await send(first.baseUrl, 'restart-safe-1');
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.run.id, 'run-restart-safe-1');
    assert.equal(body.outbox.status, 'submitted');
    assert.equal(firstDispatches, 1);
  } finally {
    first.server.close();
  }

  let secondDispatches = 0;
  const second = await createFixture({
    outboxPath,
    onSend: async () => {
      secondDispatches += 1;
      throw new Error('duplicate dispatch');
    }
  });
  try {
    const response = await send(second.baseUrl, 'restart-safe-1');
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.run.id, 'run-restart-safe-1');
    assert.equal(body.outbox.status, 'submitted');
    assert.equal(secondDispatches, 0);
  } finally {
    second.server.close();
  }
});

test('outbox API edits, reorders, and cancels queued thread messages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-api-'));
  const outboxPath = path.join(root, 'outbox.json');
  const activeRun = {
    id: 'busy-run',
    threadId: 'thread-a',
    codexSessionId: 'thread-a',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  };
  const fixture = await createFixture({ outboxPath, runs: [activeRun] });
  try {
    const first = await (await send(fixture.baseUrl, 'queued-1', '第一条')).json();
    const second = await (await send(fixture.baseUrl, 'queued-2', '第二条')).json();
    assert.equal(first.outbox.status, 'queued');
    assert.equal(second.outbox.status, 'queued');

    const edit = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '修改后的第二条' })
    });
    assert.equal(edit.status, 200);

    const harmonyEdit = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Harmony 修改后的第二条' })
    });
    assert.equal(harmonyEdit.status, 200);

    const move = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'up' })
    });
    assert.equal(move.status, 200);

    const cancel = await fetch(`${fixture.baseUrl}/api/outbox/${first.outbox.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(cancel.status, 200);

    const listed = await (await fetch(`${fixture.baseUrl}/api/outbox?threadId=thread-a`)).json();
    assert.equal(listed.items[0].id, second.outbox.id);
    assert.equal(listed.items[0].text, 'Harmony 修改后的第二条');
    assert.equal(listed.items.find((item) => item.id === first.outbox.id).status, 'canceled');
  } finally {
    fixture.server.close();
  }
});

test('outbox never steers a message into a turn whose interrupt is still pending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-interrupt-barrier-'));
  const outboxPath = path.join(root, 'outbox.json');
  const runs = [{
    id: 'run-interrupting',
    threadId: 'thread-a',
    codexSessionId: 'thread-a',
    status: 'running',
    interruptRequested: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  }];
  const steered = [];
  const dispatched = [];
  const fixture = await createFixture({
    outboxPath,
    runs,
    onSend: async (input) => {
      dispatched.push(input.submissionId);
      return {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        interruptRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
    },
    threadServiceOverrides: {
      canSteerThread() {
        return runs[0].status === 'running';
      },
      async steerMessage(input) {
        steered.push(input.text);
        return runs[0];
      }
    }
  });

  try {
    const response = await send(fixture.baseUrl, 'after-interrupt-1', '继续');
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.outbox.status, 'queued');
    assert.deepEqual(steered, []);
    assert.deepEqual(dispatched, []);

    runs[0].status = 'interrupted';
    runs[0].interruptRequested = false;
    await new Promise((resolve) => setTimeout(resolve, 275));
    await fixture.outbox.dispatchReady();

    const released = fixture.outbox.get(body.outbox.id);
    assert.equal(released.status, 'submitted');
    assert.deepEqual(steered, []);
    assert.deepEqual(dispatched, ['after-interrupt-1']);
  } finally {
    fixture.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
