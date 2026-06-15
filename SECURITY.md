# Security Policy

This project can operate a local Codex Desktop instance and can expose local automation APIs to a phone. Treat the bridge and relay as sensitive control surfaces.

## Do Not Expose Without Protection

- Do not expose the bridge port to the public internet without a strong token.
- Do not expose HDC directly to the public internet.
- Prefer a private network, SSH tunnel, or token-protected relay.
- Rotate tokens if they were ever committed, logged, screenshotted, or shared.

## Sensitive Files

Never publish:

- `*.local.psd1`
- `.env.local`
- Harmony signing files: `*.p12`, `*.p7b`, `*.cer`
- built packages: `*.hap`
- `logs/`, `tmp/`, `artifacts/`, `bin/`
- generated app config files such as `BridgeConfig.ets` and `RelayConfig.ets`

Run before publishing:

```powershell
npm run agent:verify-release
```

## If a Secret Was Published

Removing a commit is not enough once a repository has been public. If any token,
Harmony signing password, `.p12`/`.p7b`/`.cer` material, SSH host credential, or
relay token was ever pushed to a public remote, treat it as compromised:

- rotate the token or regenerate the signing material;
- force-push or recreate the public repository with clean history;
- re-run `npm run agent:verify-release`;
- avoid reusing the old signing material for public releases.

## Reporting Security Issues

Open a private advisory or contact the maintainer privately. Do not publish working exploit details before a fix is available.
