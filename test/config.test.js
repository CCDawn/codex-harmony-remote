import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveProjects, resolveWorkspaceRoot } from '../src/config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('default workspace root is derived from the project location', () => {
  assert.equal(resolveWorkspaceRoot({}), projectRoot);
});

test('CODEX_BRIDGE_WORKSPACE overrides the default workspace root', () => {
  const workspace = path.join(os.tmpdir(), 'codex-bridge-workspace');

  assert.equal(resolveWorkspaceRoot({ CODEX_BRIDGE_WORKSPACE: workspace }), path.resolve(workspace));
});

test('resolveProjects expands current Codex local projects in sidebar order', () => {
  const statePath = path.join(os.tmpdir(), `codex-project-state-${process.pid}.json`);
  const bossRoot = path.join(os.tmpdir(), 'BossAi-All');
  const vibeRoot = path.join(os.tmpdir(), 'Vibelution');
  fs.writeFileSync(statePath, JSON.stringify({
    'project-order': ['boss-id', 'vibe-id'],
    'local-projects': {
      'vibe-id': { id: 'vibe-id', name: 'Vibelution', rootPaths: [vibeRoot] },
      'boss-id': { id: 'boss-id', name: 'BossAi-All', rootPaths: [bossRoot] }
    }
  }), 'utf8');
  try {
    const projects = resolveProjects({ CODEX_GLOBAL_STATE_PATH: statePath });
    assert.deepEqual(projects.map(({ id, name, root }) => ({ id, name, root })), [
      { id: 'boss-id', name: 'BossAi-All', root: bossRoot },
      { id: 'vibe-id', name: 'Vibelution', root: vibeRoot }
    ]);
  } finally {
    fs.rmSync(statePath, { force: true });
  }
});
