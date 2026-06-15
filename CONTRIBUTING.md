# Contributing

This project is optimized for agent-assisted development. Start with `AGENTS.md`.

## Development Loop

1. Read `AGENTS.md`.
2. Run `npm test`.
3. Make the smallest useful change.
4. Run focused tests.
5. Run the full test suite.
6. Run the open-source scanner before publishing.

```powershell
npm test
powershell -ExecutionPolicy Bypass -File .\scripts\agent\scan-open-source.ps1
```

## Agent Rules

- Prefer `scripts\agent\*.ps1` entrypoints.
- Do not commit local config, logs, build outputs, HAPs, or signing files.
- Do not silently restart Codex Desktop in repair flows.
- Keep phone-facing recovery explicit and observable.
- Keep deployment docs runnable by another agent on a fresh Windows machine.

## Pull Request Checklist

- [ ] Tests pass.
- [ ] Open-source scan passes.
- [ ] No real IP, token, device ID, signing file, HAP, log, or generated config is committed.
- [ ] Docs or manifests are updated when deployment behavior changes.
