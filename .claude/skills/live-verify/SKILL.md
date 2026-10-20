---
name: live-verify
description: Run the live soak suite and client contract checks against a running gateway. Use before a release, after protocol changes, or when coding agents have updated.
---

# Live verification

Needs VS Code running the gateway (dev build on 24445 recommended) with the
Copilot consent approved, and the agents installed. Not run in CI.

## 0. Prepare

```powershell
pwsh -NoProfile -File scripts/install.ps1 -Dev
curl -s http://127.0.0.1:24445/health      # buildTime should be recent
node test-live/contracts/versions.mjs      # installed vs latest agent versions
```

Update agents that are behind if the release should cover them. Back up every
agent config the run touches; the suites must leave them unchanged.

## 1. Contract checks

```bash
node test-live/contracts/check.mjs                  # all agents
node test-live/contracts/check.mjs --only codex,claude
```

A recording proxy captures each agent's request shape (types and keys, no
content) and compares it with the stored snapshot. A diff means the agent
changed what it sends. Handle new shapes with `fix-client-contract-break`,
then refresh with `--update` and review the snapshot diff before committing.

## 2. Soak suite

```bash
node test-live/soak/soak.mjs --base http://127.0.0.1:24445 --label <label>
node test-live/soak/soak.mjs --only claude-image,gemini-fetch   # subset
node test-live/soak/soak.mjs --help                             # list scenarios
```

Needs `claude`, `codex` and `gemini` on PATH; on Windows set `CODEX_EXE` to
the native `codex.exe` in the `@openai/codex` package. The runner temporarily
patches `~/.gemini/settings.json` (backup `settings.json.soak-backup`) and
restores it; after a hard kill, restore it by hand.

Runs Claude Code, Codex and Gemini CLI through the gateway on real tasks
(details in `test-live/soak/README.md`):

- Multi-file edits: tool calls and tool results round-trip.
- Long history: earlier turns, tool calls and reasoning replay correctly.
- Images: image inputs reach the model.
- Cancel: client disconnects end the model call cleanly.
- Web search and fetch: the hosted search loop and URL fetch work.
- Concurrency: parallel requests do not mix streams.

## 3. Read failures

Get the request ID for each failure and find its line in the "Agent Gateway"
log (see `dev-loop`). Then classify:

- Gateway bug: non-200 status, entry in the error log, malformed stream, or a
  wrong result you can reproduce with `curl` or the agent directly.
- Harness bug: the log shows 200 and the agent did the work, but the check
  failed, e.g. a log-line matcher expecting old wording, a short timeout, a
  path assumption. Fix the harness, not the gateway.
- Model flake: rerun the single scenario; only repeatable failures count.

## 4. Clean up

Diff every agent config against your backup and restore any difference.
Remove temp dirs and `.agent-gateway-*.bak` files the run created.
