import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDiagnostics } from '../src/desktopLiveDiagnostics.js';

const packagedShell = '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__test\\app\\ChatGPT.exe"';

test('desktop diagnostics recognize the packaged ChatGPT main process and ignore its children and app-server', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-07-28T00:00:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 100,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: packagedShell,
        creationDate: '2026-07-28T00:00:00.000Z'
      },
      {
        processId: 101,
        parentProcessId: 100,
        name: 'ChatGPT.exe',
        commandLine: `${packagedShell} --type=renderer`,
        creationDate: '2026-07-28T00:00:01.000Z'
      },
      {
        processId: 102,
        parentProcessId: 100,
        name: 'codex.exe',
        commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__test\\app\\resources\\codex.exe" app-server',
        creationDate: '2026-07-28T00:00:02.000Z'
      }
    ]
  }, { desktopLive: false });

  assert.equal(result.desktopProcessMode, 'plain');
  assert.equal(result.codexProcessCount, 1);
  assert.equal(result.codexProcessId, 100);
  assert.equal(result.failureClass, 'codex_plain_no_cdp');
});

test('desktop diagnostics extract CDP from the packaged ChatGPT main process', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-07-28T00:00:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 200,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: `${packagedShell} --remote-debugging-port=54808`,
        creationDate: '2026-07-28T00:00:00.000Z'
      }
    ]
  }, { desktopLive: false });

  assert.equal(result.desktopProcessMode, 'cdp');
  assert.equal(result.codexProcessCount, 1);
  assert.equal(result.cdpPort, 54808);
  assert.equal(result.requiresDesktopCdp, false);
});
