import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexThreadService } from '../src/codexThreadService.js';

test('desktop listing uses protocol pagination and never merges internal local records', async () => {
  const requests = [];
  const service = new CodexThreadService({
    allowIndependentAppServer: false,
    projectHistoryPath: null,
    runStatePath: null,
    sessions: { listSessions() { throw new Error('must not scan local history'); } },
    desktopThreadListProvider: async (params) => {
      requests.push(params);
      return params.cursor
        ? { data: [{ id: 'user-2', name: 'second', isPinned: true }], nextCursor: null }
        : { data: [{ id: 'user-1', name: 'first' }], nextCursor: 'next' };
    }
  });
  service.liveSessions.set('guardian-review', { id: 'guardian-review', title: 'internal' });
  const threads = await service.listThreads({ limit: 10 });
  assert.deepEqual(threads.map(t => t.id), ['user-1', 'user-2']);
  assert.equal(threads[1].pinned, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].archived, false);
  assert.equal(requests[0].useStateDbOnly, true);
  assert.equal(requests[1].cursor, 'next');
  assert.equal(requests[0].sourceKinds, undefined);
});

test('desktop listing exposes disconnection instead of presenting stale database success', async () => {
  const service = new CodexThreadService({
    allowIndependentAppServer: false, projectHistoryPath: null, runStatePath: null,
    sessions: { async listSessions() { return [{ id: 'stale' }]; } },
    desktopThreadListProvider: async () => { throw new Error('desktop offline'); }
  });
  await assert.rejects(service.listThreads(), /desktop offline/);
  service.desktopThreadListProvider = null;
  await assert.rejects(service.listThreads(), /列表接口未连接/);
});
