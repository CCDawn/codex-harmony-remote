# Agent Configuration Guide

## Local Config Files

Local files are intentionally ignored by git:

- `tools\harmony\hdc-relay.local.psd1`
- `tools\harmony\virtual-hdc.local.psd1`
- `HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets`
- `.env.local`

Create them with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\setup.ps1
```

## Bridge Config

Template:

```text
HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.example.ets
```

Generated local file:

```text
HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets
```

Fields:

- `DEFAULT_BRIDGE_URL`: URL the phone app uses.
- `DEFAULT_BRIDGE_TOKEN`: bridge token. Empty is acceptable only on private local links.
- refresh interval constants: app polling intervals.

## HDC Relay Config

Template:

```text
tools\harmony\hdc-relay.example.psd1
```

Local file:

```text
tools\harmony\hdc-relay.local.psd1
```

Fields:

- `RelayHost`: public relay server host or IP.
- `RelayPort`: public relay port.
- `Token`: shared relay token.
- `DeviceId`: HDC target device id.
- `ProxyHost` and `ProxyPort`: local proxy that `hdc.exe` connects to.
- `HdcdHost` and `HdcdPort`: phone-side `hdcd` TCP endpoint.
- `HdcPath`: absolute path to `hdc.exe`.

## Virtual HDC Config

Template:

```text
tools\harmony\virtual-hdc.example.psd1
```

Local file:

```text
tools\harmony\virtual-hdc.local.psd1
```

Use this when the phone and Windows host are connected through a virtual private network.

## Environment Variables

Agents may use:

- `CODEX_BRIDGE_TOKEN`: bridge token used by agent scripts.
- `CODEX_BRIDGE_URL`: bridge URL used by agent scripts.
- `CODEX_HDC_PATH`: absolute path to `hdc.exe`.

Environment variables should override examples but not silently overwrite `.local` files.

## App Server Runtime

The phone always connects only to the Bridge. In explicit App Server
compatibility modes, the Bridge owns the local Codex App Server stdio process;
do not expose that process or a local App Server port to the phone or the
public relay.

- `CODEX_BRIDGE_RUNTIME_MODE`: `desktop`, `app-server-shadow`,
  `app-server-new-only`, `app-server-canary`, or `app-server-primary`.
- `CODEX_BRIDGE_APP_SERVER_CANARY_THREADS`: comma-separated existing thread ids
  used only with `app-server-canary`.
- `CODEX_BRIDGE_APP_SERVER_SANDBOX`: defaults to `workspace-write`.
- `CODEX_BRIDGE_APP_SERVER_APPROVAL_POLICY`: defaults to `on-request`.

`npm.cmd run agent:start` defaults to `desktop`. The Bridge connects to the App
Server embedded in the running Codex desktop process, so the desktop and phone
have one authoritative thread/turn/event owner. The phone and desktop keep
independent selected-thread cursors: selecting or sending to thread B on the
phone does not navigate the desktop away from thread A.

Existing-thread sends require a live desktop channel and successful target
verification through the desktop-owned App Server. The desktop's currently
visible thread id may differ from the phone target. Messages, turns, streaming
events, interrupts, approvals, and history remain keyed by `threadId` and
`turnId`; opening B later on the desktop shows the same canonical turn.

To explicitly select the recommended desktop-owned runtime:

```powershell
npm.cmd run agent:start -- -RuntimeMode desktop -ForceRestart
```

Independent `app-server-*` modes remain available only for explicit headless
or compatibility operation. They start a separate App Server owner and
therefore do not provide live desktop frontend unity.
