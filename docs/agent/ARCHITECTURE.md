# Agent Architecture Notes

## High-Level Chain

Phone App -> Bridge URL -> Node bridge -> Codex session store and desktop live/CDP channel.

Optional wireless HDC chain:

Phone helper -> public relay server -> Windows local proxy -> `hdc.exe` -> phone `hdcd`.

## Components

### Node Bridge

Path: `src/`

Responsibilities:

- Expose phone-facing HTTP APIs.
- Read Codex session history.
- Send messages to the selected Codex desktop thread through the desktop live channel.
- Report link status through `/system/link/status`.
- Attempt recoveries through `/system/link/recover`.

### Main HarmonyOS App

Path: `HarmonyCodexRemote/`

Bundle: `com.codex.remote.app`

Responsibilities:

- Show Codex sessions.
- Send text and images.
- Show streaming/running states.
- Interrupt or guide running turns.
- Capture desktop screenshots through the bridge.
- Let the user trigger link recovery from the phone.

### HDC Relay Helper

Path: `HarmonyHdcRelayHelper/`

Bundle: `com.codex.remote.hdc.helper`

Responsibilities:

- Keep phone-side relay connectivity available.
- Help wireless HDC remain usable when the phone is not on the same LAN.

### Agent Scripts

Path: `scripts/agent/`

Responsibilities:

- Give external agents stable commands.
- Return machine-readable status where possible.
- Avoid requiring agents to reconstruct historical local command lines.

## Important Constraints

- CDP cannot be recovered from inside the phone if Codex Desktop was launched without a CDP-capable entrypoint.
- Phone-side recovery should prefer soft bridge/live-host recovery and must not restart Codex Desktop unless the user explicitly chooses that behavior.
- HDC relay does not replace Codex desktop live/CDP. They are separate links.
