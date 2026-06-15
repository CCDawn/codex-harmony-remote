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
