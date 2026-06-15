# Mobile Remote Control Robustness

## Current Rule

Phone-facing changes should use the safe deployment gate:

```powershell
npm run deploy:safe -- -DeviceId <your-device-id>
```

For remote HDC where the helper app carries the HDC tunnel:

```powershell
npm run deploy:safe -- -DeviceId 127.0.0.1:11078 -RelayHostedByHelper
```

## What The Gate Checks

- Bridge health: `GET /health`
- Codex session API: `GET /api/codex/threads`
- HDC target availability: `hdc shell echo`
- App startup and recent app log upload
- Node regression tests before deployment
- Post-deployment smoke test

## Rollback

The safe deployment script keeps a known-good HAP at:

```text
artifacts/hap/known-good/last-known-good.hap
```

If deployment succeeds but the post-deploy smoke test fails, the script installs `last-known-good.hap` and re-runs the smoke test.

## Remaining Hard Failure Cases

- If the same main app is the only HDC relay carrier and a bad update kills it, remote HDC can drop before rollback.
- If bridge, server relay, and phone network are all unavailable, recovery needs local/USB access.
- If HarmonyOS kills background execution or notification permission is revoked, monitoring can pause until the app is opened again.

For high-risk changes to relay startup, bridge URL configuration, app lifecycle, or permissions, prefer a helper-carried HDC path or USB validation first.

## Background And Lockscreen Evidence

Run:

```powershell
npm run link:background -- -DeviceId <your-device-id>
```

Observed on 2026-05-30:

- Foreground baseline passed: bridge, Codex session API, HDC, and app log upload were healthy.
- After sending Home, app-originated bridge polling stopped after the short grace window. No sustained background session polling was observed.
- During screen suspend, app-originated polling also paused. After wake, the app recovered and resumed polling, but one dashboard timeout was logged before recovery.

Current contract:

- The app can recover after background/lockscreen in this test.
- The app must not be treated as a reliable real-time background monitor yet.
- Completion notifications only arrive while HarmonyOS lets the app run or after the app wakes and catches up.

Required next architecture step for real-time background monitoring:

- Move monitoring and relay ownership out of UI-only timers into a dedicated background-capable service/helper path, or use an OS-supported long-running task mechanism that is verified by `link:background`.

## HDC Relay Diagnosis Notes

`phones=[]` from `/__relay/state` does not always mean the phone helper is offline. In the relay protocol, a phone waiting for the PC is listed under `phones`, but once the PC proxy pairs with it, that waiting entry is consumed and the HDC byte stream occupies the channel.

Use this order for diagnosis:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harmony\check-relay-state.ps1 -SkipDesktopScreenshot
& 'C:\openHarmony\20\toolchains\hdc.exe' -t 127.0.0.1:11078 shell echo relay-ready
```

If `hdc shell` returns `relay-ready`, the helper path is usable even when `phones` is empty. New relay server builds also expose `activeHdc`; old relay servers do not, so local scripts must tolerate the field being absent.

The local watchdog must keep three pieces aligned:

- `127.0.0.1:11078` local proxy is listening.
- `hdc tconn 127.0.0.1:11078` is connected.
- Relay state has either `phones`, `pendingPc`, or `activeHdc` for the configured device, with old servers falling back to direct HDC shell probing.
