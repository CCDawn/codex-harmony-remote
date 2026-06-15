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
