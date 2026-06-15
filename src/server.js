import { createApp } from './app.js';
import { config } from './config.js';
import { CodexExecAdapter } from './codexExecAdapter.js';
import { CodexAppServerAdapter } from './codexAppServerAdapter.js';
import { CodexDesktopCdpAdapter } from './codexDesktopCdpAdapter.js';
import { HybridCodexAdapter } from './hybridCodexAdapter.js';
import { MockCodexAdapter } from './mockCodexAdapter.js';

const adapter = createAdapter();

const { server, logger } = createApp({ config, adapter });

await logger.startRun(process.env.CODEX_BRIDGE_RUN_LABEL ?? 'bridge-start');

server.listen(config.port, config.host, () => {
  console.log(`Codex bridge probe listening on http://${config.host}:${config.port}`);
  console.log(`Logs: ${logger.currentRunDir}`);
});

function createAdapter() {
  if (process.env.CODEX_BRIDGE_ADAPTER === 'mock') {
    return new MockCodexAdapter();
  }
  if (process.env.CODEX_BRIDGE_ADAPTER === 'exec') {
    return new CodexExecAdapter();
  }
  if (process.env.CODEX_BRIDGE_ADAPTER === 'app-server') {
    return new CodexAppServerAdapter();
  }
  if (process.env.CODEX_BRIDGE_ADAPTER === 'desktop-cdp') {
    return new CodexDesktopCdpAdapter();
  }
  return new HybridCodexAdapter();
}
