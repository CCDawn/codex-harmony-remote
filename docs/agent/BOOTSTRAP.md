# Agent Bootstrap Runbook

This runbook is written for a deployment agent that has shell access to a Windows machine.

## Goal

Bring up Codex Harmony Remote from a fresh clone and deploy the HarmonyOS main app to a phone.

## Phase 1: Inspect

Run:

```powershell
Get-Location
Get-Content -Raw .\project.manifest.json
Get-Content -Raw .\deploy.manifest.json
```

Expected:

- The current directory is the repository root.
- `project.manifest.json` points to this file and `AGENTS.md`.

## Phase 2: Install Node Dependencies

Run:

```powershell
npm install
```

Expected:

- `node_modules/` exists.
- `npm test` can run the Node test suite.

## Phase 3: Create Local Config

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\setup.ps1
```

Expected:

- `tools\harmony\hdc-relay.local.psd1` exists.
- `tools\harmony\virtual-hdc.local.psd1` exists.
- `HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets` exists.

If the files were newly created, ask the user or host agent for local values before deploying:

- HDC path.
- Device ID.
- Bridge URL.
- Bridge token.
- Public relay host and token, when using remote relay mode.

## Phase 4: Diagnose

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\doctor.ps1 -Json
```

Expected:

- Required checks should be `ok` before deployment.
- Optional checks may be `warn` when the bridge or phone is not started yet.

Do not guess. Use the JSON output to choose the next action.

## Phase 5: Start Local Stack

For local/LAN debugging:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\start-stack.ps1 -SkipHdcRelay
```

For relay mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\start-stack.ps1
```

Expected:

- Local bridge listens on the configured bridge port.
- Desktop live channel is ready when Codex Desktop is launched with a CDP-capable entrypoint.
- Relay proxy is ready when relay mode is used.

## Phase 6: Build And Deploy Main App

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\deploy-app.ps1 -Build
```

Expected:

- A HAP is built locally.
- The app is installed to the selected phone.
- The app is launched unless `-SkipLaunch` is passed.

## Phase 7: Verify

Run again:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\doctor.ps1 -Json
```

Expected core success:

- `node` is `ok`.
- `bridge` is `ok`.
- `sessions` is `ok`.
- `hdc` is `ok` when deploying to a phone.

If `cdp` is not `ok`, do not claim desktop-live sending is verified.
