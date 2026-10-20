# Automated soak suite

This suite runs the real Claude Code, Codex and Gemini CLIs against a running
gateway. Each scenario runs in its own scratch repository under
`%TEMP%/agent-gateway-soak/<timestamp>/<scenario>`. Run it before each
release.

```powershell
node test-live/soak/soak.mjs --base http://127.0.0.1:24445 --label <label>
node test-live/soak/soak.mjs --only claude-image,gemini-fetch   # subset
node test-live/soak/soak.mjs --help                             # list scenarios
```

Requires Node 22, and `claude`, `gemini` and `codex` on PATH. On Windows, set
`CODEX_EXE` to the native `codex.exe` inside the `@openai/codex` package
(`vendor/<target>/bin/codex.exe`), because the npm shim cannot be spawned
directly.

## How clients are pointed at the gateway

- **Claude Code**: `claude -p` with a temporary `--settings` file that sets
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. This file is required because
  `~/.claude/settings.json` may point at the production port 24444.
- **Codex**: `codex exec` with `-c` overrides that define a `soak` provider
  (`base_url=<base>/v1`, `wire_api="responses"`, `env_key`). It also passes
  `--skip-git-repo-check` and `--dangerously-bypass-approvals-and-sandbox`.
- **Gemini**: `gemini -p --yolo` with `GOOGLE_GEMINI_BASE_URL` and
  `GEMINI_API_KEY=dummy`. Gemini CLI only accepts the key when
  `~/.gemini/settings.json` has `security.auth.selectedType = "gemini-api-key"`.
  The runner backs that file up to `settings.json.soak-backup`, patches it, and
  restores it in a `finally` block and on SIGINT/SIGTERM. If a run is hard-killed,
  restore the file from the backup by hand.

The runner does not modify any other user configuration.

## Scenarios

| Scenario              | Assertion                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| claude-multifile-edit | Three buggy JS files are fixed (`node` check)                                                                            |
| claude-long-history   | A second turn with `--continue` appends to a file and recalls a code word                                                |
| claude-websearch      | The answer contains 1991 and a URL. Skipped when `agentGateway.webSearch.provider` is unset                              |
| claude-image          | A generated red 16x16 PNG is described as "red"                                                                          |
| claude-cancel         | The client is killed 3 s after the gateway sees the request, and the gateway log shows a disconnect or abort             |
| claude-long-run       | `guide.md` is larger than 8 KB and the run takes more than 60 s                                                          |
| claude-long-answer    | `essay.md` (600-word request) has at least 450 words, so the answer was not cut short                                    |
| codex-shell-patch     | Three buggy files are fixed with shell commands and apply_patch                                                          |
| codex-live-search     | `web_search="live"`, and `year.txt` contains 2015                                                                        |
| codex-effort          | `model_reasoning_effort="high"`, and `fib.txt` is 6765                                                                   |
| codex-cache-key       | Two turns, the second with `exec resume --last`. Both files exist, and there are at least 2 distinct gateway request ids |
| gemini-tools-edit     | Three buggy files are fixed                                                                                              |
| gemini-search         | The answer contains 2009 and a URL                                                                                       |
| gemini-fetch          | The answer contains "Example Domain"                                                                                     |
| concurrent            | Claude, Codex and Gemini each fix their own copy at the same time                                                        |

Each scenario has a timeout and a deterministic assertion. After the assertion
passes, the runner reads `/health` `errors.recent`. Any gateway journal error
recorded in the scenario's time window fails the scenario, except cancellation
errors in `claude-cancel`. Gateway log lines come from the dev extension's
`Agent Gateway.log` in the VS Code logs directory.

## Results

Results are written to `results/<label>/summary.json` and `summary.md`. Each
scenario records its status, duration, failure reason and scratch directory.
The `results/` directory is gitignored except for `.gitkeep`.

## Notes

- Codex runs shell tools as a login shell, so a PowerShell profile that changes
  directory would make files land outside the scratch repo. The runner passes
  `-c allow_login_shell=false`, so Codex uses `pwsh -NoProfile`.
- Codex warns `Model metadata for <model> not found` for the gateway models.
  This warning is harmless.
