---
name: dev-loop
description: Build, install, reload and verify Agent Gateway during development. Use when changing extension code and running it in VS Code, checking which build is live, finding the gateway log, or running the tests.
---

# Dev loop

## Build and install

```powershell
pwsh -NoProfile -File scripts/install.ps1 -Dev   # dev build, port 24445
pwsh -NoProfile -File scripts/install.ps1        # release build, port 24444
```

- The dev build (`ness001.agent-gateway-dev`) runs next to the release build.
  `install.ps1 -Dev` writes the trigger file `agent-gateway-dev.reload` in the
  OS temp dir; running dev windows watch it (`src/gateway/devVariant.ts`,
  `src/extension.ts`) and restart their extension host by themselves.
- The release build needs **Developer: Reload Window**.
- `-PackageOnly` builds the VSIX without installing; `-CodeCommand
code-insiders` targets Insiders.

## Confirm the new build is live

```bash
curl -s http://127.0.0.1:24445/health
```

Compare `buildTime` with when you installed. If it is old, the window did not
restart: reload it.

**Copilot consent gotcha:** after a fresh install VS Code asks whether the
extension may use the Copilot language models. Until someone clicks Allow,
model calls fail or stall. If requests hang right after an install, look for
the prompt in the VS Code window.

## Read the log

Output panel **Agent Gateway**, or the file:

- Windows:
  `%APPDATA%\Code\logs\<session>\window*\exthost\ness001.agent-gateway[-dev]\Agent Gateway.log`
- macOS: `~/Library/Application Support/Code/logs/` (same tail)
- Linux: `~/.config/Code/logs/` (same tail)

Use the newest `<session>`. One line per request:
`[<id>] <protocol> <method> <path> model=... status=... <ms>`. Send your own
`request-id` or `x-request-id` header to find a request quickly (gateway IDs
look like `req_…`); error bodies carry the same
`request_id`. Set `agentGateway.logLevel` to `debug` for provider error
messages.

## Tests

```powershell
pwsh -NoProfile -File scripts/run-tests.ps1
```

Type check, lint, script tests, test build, bundle load check, Mocha suite in
VS Code, production bundle budget (450 KB). Faster inner loop:
`pnpm run check-types`, `pnpm run lint`, `pnpm test`.

## Running agent CLIs from scripts

Non-interactive agents can hang waiting on stdin. Always close it:

```bash
claude -p "fix the bug in m.py" < /dev/null
codex exec "fix the bug in m.py" < /dev/null
```

Run them in a temp directory and point them at port 24445 when testing the
dev build.
