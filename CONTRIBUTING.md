# Contributing

Thanks for helping improve Agent Gateway. This guide covers building, testing,
the code layout and the rules every change follows. User-facing documentation
is in the [README](README.md) and [docs/reference.md](docs/reference.md).

## Prerequisites

- VS Code with GitHub Copilot Chat, signed in.
- Node.js 22 and pnpm.
- PowerShell 7 for the helper scripts in `scripts/` (Windows, macOS or Linux).

## Build and install

```powershell
pnpm install
pnpm run build                               # type-check and bundle to dist/extension.cjs
pwsh -NoProfile -File scripts/install.ps1     # build and install the release VSIX (port 24444)
pwsh -NoProfile -File scripts/install.ps1 -Dev  # side-by-side dev build (port 24445)
```

`install.ps1` also accepts `-PackageOnly` (build the VSIX without installing)
and `-CodeCommand code-insiders`. Reload VS Code after installing and approve
the Copilot language model prompt.

The dev build (`ness001.agent-gateway-dev`) always listens on `24445`, so it
can run next to the release build. After `install.ps1 -Dev`, running dev
windows restart their extension host automatically.

## Tests

```powershell
pwsh -NoProfile -File scripts/run-tests.ps1
```

This runs, in order: type checks, ESLint, script tests, the test build, the
bundle and its load check, the Mocha suite inside VS Code (`pnpm test`,
extensions disabled) and the bundle-size budget (450 KB). CI runs the same
checks on Windows, Linux and macOS.

### Live checks

The soak suite needs a running gateway and real clients; it is run before a
release, not in CI.

- **Soak** (`test-live/soak/soak.mjs`): runs Claude Code, Codex and Gemini CLI
  through the gateway on real tasks (multi-file edits, long history, images,
  cancel, web search and fetch, concurrency). See
  [test-live/soak/README.md](test-live/soak/README.md).

## Code layout

| Path               | Contents                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts` | Activation, commands, status bar.                                                                                                                                                                                                            |
| `src/gateway/`     | HTTP listener, model discovery, remote upstreams, health, error journal, dev tunnel.                                                                                                                                                         |
| `src/protocol/`    | The protocol layer: `core/` (request model, VS Code LM calls, errors, usage), `http/` (SSE, scope), one folder per API (`anthropic/`, `openai/chat`, `openai/responses`, `gemini/`), `hosted/` (web search engines, search loop, URL fetch). |
| `src/clients/`     | One adapter per coding agent for **Configure Coding Agents** (plan, apply with backup, undo).                                                                                                                                                |
| `src/commands/`    | Command Palette commands.                                                                                                                                                                                                                    |
| `src/utils/`       | Settings, logger, constants.                                                                                                                                                                                                                 |
| `src/test/`        | Mocha unit tests; `perf/` holds the performance tests.                                                                                                                                                                                       |
| `scripts/`         | Build, install, test and bundle-check helpers.                                                                                                                                                                                               |
| `test-live/`       | Live tests against real clients.                                                                                                                                                                                                             |
| `docs/`            | Reference documentation.                                                                                                                                                                                                                     |

A request flows: `gateway/app.ts` (auth, model resolution) → `protocol/index.ts`
(route) → `<api>/decode.ts` (wire request to a common request) →
`core/runTurn.ts` (VS Code language model call, optional hosted search loop) →
`<api>/encode.ts` (events back to the wire format).

### Adding a coding agent

1. Add an adapter in `src/clients/` implementing `ClientAdapter`
   (`types.ts`): detection paths, config paths, `plan` and `unplan`. Plans must
   be idempotent and keep unrelated settings and comments.
2. Register it in `src/clients/index.ts` and add tests in `src/test/clients/`.
3. Verify it live: install the agent, run **Configure Coding Agents**, and have
   the agent edit a file through the gateway.
4. Add it to the README's supported-agents table.

## Rules

- **Privacy.** Never log prompts, request bodies, tool arguments, search
  queries, URLs, page text or credentials. Use the typed logger in
  `protocol/core/log.ts`.
- **No secrets or personal data** in commits, fixtures or docs: no API keys,
  tokens, internal registry URLs or user names and home paths.
- **Lockfile.** `pnpm-lock.yaml` must not contain `tarball:` URLs (CI
  checks). If your registry adds them, remove them before committing:
  `sed -i -E 's/, tarball: [^}]*\}/}/' pnpm-lock.yaml`.
- **Bundle budget.** `dist/extension.cjs` stays under 450 KB.
- **Style.** Prettier and ESLint as configured; match the surrounding code.

## CI and releases

Every push to `main` and every pull request runs
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) on Ubuntu, Windows and
macOS, with the same checks as `scripts/run-tests.ps1` (the VS Code tests run
under `xvfb-run` on Linux). When all three pass, a production VSIX is uploaded
as the `agent-gateway-vsix` artifact.

To release:

1. Update `version` in `package.json` and the [changelog](CHANGELOG.md).
2. Run the soak suite against a dev build.
3. Push to `main` and wait for CI to pass on all three OSes.
4. Tag that commit: `git tag v0.1.1 && git push origin v0.1.1`.

[`.github/workflows/release.yml`](.github/workflows/release.yml) does not rerun
the tests. It stops unless CI passed on the tagged commit, checks the tag
matches the version, builds and size-checks the production bundle, and creates
a GitHub release with the VSIX attached. It publishes to the VS Code Marketplace when the `VSCE_PAT`
repository secret is set, and to Open VSX when `OVSX_PAT` is set; each publish
step is skipped when its secret is missing.

Claude Code users: project skills in `.claude/skills/` (add-coding-agent, fix-client-contract-break, dev-loop, live-verify, release, docs-style).

## Client contract checks

Coding agents change what they send over time (new tool types, input items,
headers, endpoints). [`test-live/contracts/`](test-live/contracts) notices
this before users do:

- `check.mjs` runs each installed client (Claude Code, Codex, Gemini CLI, Pi,
  omp, Hermes, Kilo Code, Cline, DeepSeek Harness, OpenClaw) once through a
  recording proxy in front of a running gateway, asking it to fix a one-line
  bug in a temp directory. Client configs are generated by the extension's own
  adapters into a throwaway home and selected with env vars or flags, so your
  real client configs are not touched. The proxy keeps only a redacted request
  shape (key paths, value types, discriminator values such as tool and input
  item types, header names); no prompts, tool schemas or credentials.
  Antigravity CLI is included too.
  The shape is compared with `test-live/contracts/snapshots/<client>.json`.
  Clients that are not on `PATH` are skipped.
- `versions.mjs` compares each snapshot's client version with the latest
  published release (npm calls pass `--registry` from `NPM_REGISTRY`, else
  `npm config get registry`). `.github/workflows/contracts.yml` runs it weekly and opens
  an issue when a client has a newer release.

Run it before a release and whenever the weekly job flags a new client
version:

```sh
pnpm run build-tests
node test-live/contracts/check.mjs                  # all installed clients, gateway on :24444
node test-live/contracts/check.mjs --only codex,kilo --target http://127.0.0.1:24445
```

Codex is found on `PATH` or inside a global `@openai/codex` npm install;
set `CODEX_EXE` to override. Antigravity CLI is found as `agy` or
`antigravity` on `PATH`; set `AGY_EXE` otherwise. A non-zero exit lists
each new or removed value (for example `POST /v1/responses: new tools.type
value \`tool_search\``), failed model calls, and whether the client fixed the
file. After adapting the gateway to a change, rerun with `--update` and commit
the changed snapshots.

## Performance tests

`src/test/perf/` measures the gateway's own cost and runs with `pnpm test`
(about 5 s); `pnpm run perf` runs only that folder. With a fake model over
loopback HTTP it reports, per API and for a small and a ~1 MB request, the
request overhead (request received to model call), per-chunk overhead (model
chunk to bytes at the client) and the non-streamed total. It also times
loading `dist/extension.cjs` and `activate()` until `/health` answers, in a
fresh process with a stub `vscode` (skipped when `dist/` is not built). Each
row's p95 must stay under the ceiling (5 to 10 times a local run) in `src/test/perf/budgets.json`;
one combined table is printed at the end.

## Investigation skill

For Codex session replay, standalone tool events, or custom-provider protocol
failures, use the repository's [Codex source diagnosis skill](.agents/skills/codex-source-diagnosis/SKILL.md).
It traces local evidence to pinned upstream source and tests without committing
private session data. The skill is not included in the extension VSIX.
