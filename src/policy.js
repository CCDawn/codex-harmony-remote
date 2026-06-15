import path from 'node:path';

const dangerousCommandPatterns = [
  /\brm\s+-rf\b/i,
  /\bRemove-Item\b.*\b-Recurse\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b.*\b--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bdeploy\b/i,
  /\bpublish\b/i
];

export function resolveWorkspacePath(project, requestedPath) {
  const root = path.resolve(project.root);
  const resolved = path.resolve(root, requestedPath ?? '.');
  const relative = path.relative(root, resolved);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }

  const error = new Error('Requested path is outside the project workspace');
  error.statusCode = 403;
  throw error;
}

export function classifyCommand(project, command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      decision: 'blocked',
      risk: 'high',
      reason: 'Command is empty or invalid'
    };
  }

  const normalized = command.trim();

  if (dangerousCommandPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      decision: 'approval_required',
      risk: 'high',
      reason: 'Command can publish, delete, deploy, or rewrite history'
    };
  }

  if (project.allowedCommands.some((pattern) => pattern.test(normalized))) {
    return {
      decision: 'allowed',
      risk: 'low',
      reason: 'Command matches project allowlist'
    };
  }

  return {
    decision: 'approval_required',
    risk: 'medium',
    reason: 'Command is not on the automatic allowlist'
  };
}
