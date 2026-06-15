# Agent Troubleshooting Guide

Always start with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\doctor.ps1 -Json
```

## Bridge Offline

Symptoms:

- `bridge` is `fail`.
- Phone shows connection failure.

Actions:

1. Start stack: `scripts\agent\start-stack.ps1`.
2. Check `logs\startup`.
3. Re-run doctor.

## Sessions Empty

Symptoms:

- `sessions` is `fail`.
- Phone shows no conversations.

Actions:

1. Confirm bridge is `ok`.
2. Confirm Codex session files exist under the user's Codex home.
3. Check `/codex/sessions` through the bridge.
4. Do not assume the phone app is broken until the bridge API is verified.

## CDP Offline

Symptoms:

- `cdp` is `warn` or `fail`.
- Desktop live sending fails.
- Phone recovery says no CDP endpoint is available.

Actions:

1. Do not claim live desktop sending is verified.
2. Try soft recovery first if the bridge is online.
3. If Codex Desktop was launched without CDP, the user must explicitly start the CDP-capable desktop path.
4. Do not silently restart Codex Desktop.

## HDC Offline

Symptoms:

- `hdc` is `fail`.
- App cannot deploy or screenshots cannot be captured.

Actions:

1. Check `HdcPath` in local config.
2. Run `hdc list targets`.
3. Unlock the phone.
4. If remote HDC is used, check relay config and helper app state.

## Relay Waiting For PC

Symptoms:

- Phone helper says it is waiting for computer.
- `relay` is not `ok`.

Actions:

1. Confirm the Windows local proxy is running.
2. Confirm `RelayHost`, `RelayPort`, `DeviceId`, and `Token` match on both sides.
3. Check firewall and VPS security group.
4. Re-run doctor and relay-specific scripts.

## Message Send Timeout

Symptoms:

- Phone shows send failed or timeout.
- Desktop may not show the message.

Actions:

1. Inspect `/system/link/status` for current session.
2. Confirm the target session id still exists.
3. Confirm desktop live/CDP status.
4. If failed message exists in the phone UI, use retry after link recovery.
5. Do not create a new thread unless the user explicitly asks.
