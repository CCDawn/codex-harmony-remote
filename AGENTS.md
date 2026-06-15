# Agent Operating Guide

This repository is agent-first. When a user asks you to deploy or debug it, read this file before touching source code.

## Project Goal

Codex Harmony Remote lets a HarmonyOS phone operate Codex Desktop through a local Node bridge, a desktop live/CDP channel, and optional wireless HDC relay tooling.

## First Files To Read

1. `project.manifest.json`
2. `deploy.manifest.json`
3. `docs/agent/BOOTSTRAP.md`
4. `docs/agent/CONFIGURATION.md`
5. `docs/agent/TROUBLESHOOTING.md`
6. `docs/agent/TASKS.md`

Do not infer the public project shape from `logs/`, `tmp/`, `artifacts/`, `bin/`, or extracted desktop bundles.

## Safe Agent Entrypoints

Prefer these commands over hand-built command lines:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent\doctor.ps1 -Json
powershell -ExecutionPolicy Bypass -File .\scripts\agent\start-stack.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent\deploy-app.ps1 -Build
powershell -ExecutionPolicy Bypass -File .\scripts\agent\scan-open-source.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent\verify-open-source-release.ps1
```

## Main Modules

- `src/`: Node bridge, Codex session API, desktop live/CDP integration, link status, and recovery.
- `HarmonyCodexRemote/`: main phone app, bundle `com.codex.remote.app`.
- `HarmonyHdcRelayHelper/`: phone-side relay helper, bundle `com.codex.remote.hdc.helper`.
- `tools/harmony/`: HarmonyOS build, deploy, HDC, relay, and diagnostics scripts.
- `scripts/agent/`: stable wrappers for deployment agents.

## Deployment Contract

The default deployment flow is:

1. Run `scripts/agent/setup.ps1`.
2. Fill local config files created from examples.
3. Run `npm install`.
4. Run `scripts/agent/doctor.ps1 -Json`.
5. Start the stack with `scripts/agent/start-stack.ps1`.
6. Build and install the app with `scripts/agent/deploy-app.ps1 -Build`.
7. Re-run `scripts/agent/doctor.ps1 -Json`.

Success means at minimum:

- Node is available.
- The local bridge responds to `/health`.
- Codex sessions can be listed through the bridge.
- HDC can see the target phone when device deployment is requested.
- CDP is available when sending to the desktop live channel is required.

## Configuration Rules

- Never write user-specific bridge URLs, tokens, device IDs, or signing paths into source files.
- Use `.local.psd1`, `.env.local`, or generated ignored config files.
- `HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets` is local/generated and ignored.
- The public template is `HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.example.ets`.

## Never Commit

- `logs/`
- `tmp/`
- `artifacts/`
- `bin/`
- `node_modules/`
- `.hvigor/`
- `*.hap`
- `*.p12`
- `*.p7b`
- `*.cer`
- `*.local.psd1`
- real public IPs, bridge tokens, relay tokens, or device IDs
- extracted Codex Desktop bundles
- copied third-party source snapshots unless their license and vendoring reason are documented

## Real-Device Debugging

Treat logs and real-device screenshots as primary evidence for HarmonyOS UI debugging.

Before a new phone test round, start a fresh bridge log run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-test-run.ps1 -Label "<short-label>"
```

After UI or phone-facing changes:

1. Deploy and launch the latest HAP.
2. Capture a phone screenshot with `npm run screen:capture -- -Name <meaningful-name>`.
3. Trigger or ask the user to trigger the target interaction.
4. Capture another screenshot.
5. Analyze only the newest logs with `npm run logs:analyze`.
6. Fix based on current screenshot plus current logs, not stale screenshots or memory.

Prefer virtual-network HDC when available:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harmony\dev-virtual.ps1
```

Use USB only to bootstrap `hdc tmode port 10178` or when virtual-network HDC is unavailable.
