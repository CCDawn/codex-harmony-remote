import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolveWorkspaceRoot();

export function resolveWorkspaceRoot(env = process.env) {
  return env.CODEX_BRIDGE_WORKSPACE
    ? path.resolve(env.CODEX_BRIDGE_WORKSPACE)
    : projectRoot;
}

export const config = {
  host: process.env.CODEX_BRIDGE_HOST ?? '127.0.0.1',
  port: Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? '8787', 10),
  projects: [
    {
      id: 'probe',
      name: 'codex-hramony',
      root: workspaceRoot,
      allowedCommands: [
        /^npm\s+test$/,
        /^npm\s+run\s+test$/,
        /^node\s+--test$/,
        /^git\s+diff(\s+--stat)?$/
      ]
    }
  ]
};
