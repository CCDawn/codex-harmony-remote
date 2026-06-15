import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { config, resolveWorkspaceRoot } from '../src/config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('default workspace root is derived from the project location', () => {
  assert.equal(resolveWorkspaceRoot({}), projectRoot);
  assert.equal(config.projects[0].root, projectRoot);
});

test('CODEX_BRIDGE_WORKSPACE overrides the default workspace root', () => {
  const workspace = path.join(os.tmpdir(), 'codex-bridge-workspace');

  assert.equal(resolveWorkspaceRoot({ CODEX_BRIDGE_WORKSPACE: workspace }), path.resolve(workspace));
});
