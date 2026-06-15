# Agent Task Recipes

Use this file when a user asks for a common operation and you need the shortest safe path.

## Fresh Setup

Goal: create local config files and verify the host.

```powershell
npm install
npm run agent:setup
npm run agent:doctor -- -Json
```

Success:

- Node is available.
- Local config files exist.
- Missing HDC, relay, or CDP values are reported as explicit warnings or failures.

## Start The Remote Stack

Goal: start the local bridge, watchdogs, optional relay, HDC proxy, and desktop live channel.

```powershell
npm run agent:start
```

Use local/LAN mode when no public relay is configured:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\start-stack.ps1 -SkipHdcRelay
```

Do not silently restart Codex Desktop. If CDP requires a hard restart, report that requirement to the user.

## Deploy The Main Phone App

Goal: build, install, and launch the main HarmonyOS app.

```powershell
npm run agent:deploy -- -Build
```

Then verify:

```powershell
npm run agent:doctor -- -Json
```

## Recover A Broken Link

Goal: recover without losing the user's current Codex desktop state.

```powershell
npm run agent:doctor -- -Json
npm run desktop:recover:soft
npm run agent:doctor -- -Json
```

If soft recovery reports that no CDP endpoint exists, do not pretend the phone can repair it. Ask the user to start the CDP-capable desktop path or explicitly approve a hard recovery.

## Debug Phone UI

Goal: use current device evidence, not stale screenshots.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-test-run.ps1 -Label "<short-label>"
npm run screen:capture -- -Name before
# trigger the interaction
npm run screen:capture -- -Name after
npm run logs:analyze
```

Use only the newest log run and screenshots for conclusions.

## Publish Or Open Source

Goal: prove the staged repository is clean before pushing.

```powershell
npm run agent:verify-release
```

This creates a clean staging directory, scans it for private data, checks forbidden file classes, and runs the test suite in the staging directory.

If any signing material, bridge token, relay token, device ID, or private server value was ever public, rotate it before publishing again.
