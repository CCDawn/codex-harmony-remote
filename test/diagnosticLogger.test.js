import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';

test('DiagnosticLogger writes redacted JSONL entries to the current run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-logs-'));
  const logger = new DiagnosticLogger({ root, maxStringLength: 20 });

  await logger.startRun('test');
  await logger.write('app', 'info', 'request.sent', {
    prompt: 'hello',
    Authorization: 'Bearer secret',
    nested: {
      password: 'pw',
      text: 'abcdefghijklmnopqrstuvwxyz'
    }
  });

  const all = await fs.readFile(path.join(root, 'current-run', 'all.jsonl'), 'utf8');
  assert.match(all, /request\.sent/);
  assert.match(all, /\[REDACTED\]/);
  assert.doesNotMatch(all, /Bearer secret/);
  assert.match(all, /truncated/);
});

test('DiagnosticLogger starts a fresh managed run without deleting device logs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-logs-'));
  const currentRun = path.join(root, 'current-run');
  await fs.mkdir(currentRun, { recursive: true });
  await fs.writeFile(path.join(currentRun, 'device_abc_hilog_latest.log'), 'device log', 'utf8');

  const logger = new DiagnosticLogger({ root });
  await logger.startRun('first');
  await logger.write('harmony-app', 'info', 'app.appear', {});
  await logger.startRun('second');

  const all = await fs.readFile(path.join(currentRun, 'all.jsonl'), 'utf8');
  const deviceLog = await fs.readFile(path.join(currentRun, 'device_abc_hilog_latest.log'), 'utf8');

  assert.match(all, /second/);
  assert.doesNotMatch(all, /app\.appear/);
  assert.equal(deviceLog, 'device log');
});
