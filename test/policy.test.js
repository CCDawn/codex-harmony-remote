import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand, resolveWorkspacePath } from '../src/policy.js';

const project = {
  root: path.resolve('sample-workspace'),
  allowedCommands: [/^npm\s+test$/]
};

test('resolveWorkspacePath allows paths inside the project root', () => {
  const resolved = resolveWorkspacePath(project, 'src/example.js');
  assert.equal(resolved, path.join(project.root, 'src', 'example.js'));
});

test('resolveWorkspacePath blocks traversal outside the project root', () => {
  assert.throws(
    () => resolveWorkspacePath(project, '..\\outside.txt'),
    /outside the project workspace/
  );
});

test('classifyCommand allows configured low-risk commands', () => {
  assert.deepEqual(classifyCommand(project, 'npm test'), {
    decision: 'allowed',
    risk: 'low',
    reason: 'Command matches project allowlist'
  });
});

test('classifyCommand requires approval for deploy commands', () => {
  const result = classifyCommand(project, 'deploy latest build');
  assert.equal(result.decision, 'approval_required');
  assert.equal(result.risk, 'high');
});

test('classifyCommand requires approval for unknown commands', () => {
  const result = classifyCommand(project, 'node scripts/custom.js');
  assert.equal(result.decision, 'approval_required');
  assert.equal(result.risk, 'medium');
});
