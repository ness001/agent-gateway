---
name: add-coding-agent
description: Add Configure Coding Agents support for a new coding agent (CLI or editor extension). Use when asked to support, integrate or auto-configure another agent against the gateway.
---

# Add a coding agent

Adapters live in `src/clients/` and implement `ClientAdapter` from
`src/clients/types.ts`. They are pure: they receive file text and return
planned changes; `src/clients/apply.ts` does the writing (atomic write plus a
`<file>.agent-gateway-<stamp>.bak` backup). Use `src/clients/ompPi.ts` and
`src/clients/openclawHermes.ts` as models.

## 1. Install the agent and find its real config

- Install it the way users do (`npm i -g ...`, pipx, installer). npm installs
  may need the machine's configured registry; never hard-code one anywhere.
- Find the config path from the agent's docs or source, on every OS:
  - Check env overrides first (`*_HOME`, `*_STATE_DIR`, `XDG_CONFIG_HOME`).
  - Do not assume `~/.<name>` on Windows. Hermes uses `%LOCALAPPDATA%\hermes`
    on Windows; confirm by running the agent once and looking for the file.
- Note how it lists models: `/v1/models` (`auto`), a written list (`static`),
  one model (`single`) or `manual` steps. Note which API it speaks
  (Anthropic Messages, OpenAI Chat, OpenAI Responses, Gemini).

## 2. Write the adapter

- `detectPaths` / `configPaths` take `home` and `platform`; read env
  overrides the same way `openclawHermes.ts` does.
- `plan()` adds an entry named `GATEWAY_PROVIDER_ID` pointing at
  `input.gatewayUrl`, with `input.apiKey ?? PLACEHOLDER_API_KEY`.
- Edit in place: `jsonc-parser` `modify`/`applyEdits` for JSON/JSONC, `yaml`
  `parseDocument` for YAML, targeted text edits for TOML. Keep comments,
  ordering and every unrelated setting.
- Idempotent: `plan()` on already-planned text yields `before === after`.
- `unplan()` removes only what `plan()` added and restores values it
  replaced.
- Put unverified behaviour in `caveat`; set `afterApply` if the agent must be
  restarted.

## 3. Register and test

- Add it to `ALL_CLIENT_ADAPTERS` in `src/clients/index.ts`.
- Add its id to the expected id list in `src/test/clients/apply.test.ts`.
- Add `src/test/clients/<name>.test.ts`: fresh file, existing file with
  comments and other providers, idempotent re-plan, unplan round-trip back to
  the original text, env override paths, Windows/macOS/Linux paths.
- Run `pwsh -NoProfile -File scripts/run-tests.ps1`.

## 4. Verify live (never leave the user's config modified)

1. Copy the agent's config files to a temp backup.
2. Install the dev build (see `dev-loop`) and check
   `curl -s http://127.0.0.1:24445/health`.
3. `pnpm run build-tests`, then apply the plan with a small node script that
   `require`s the compiled adapter and `applyPlan` from `out/clients/`
   (gateway URL `http://127.0.0.1:24445`, models from `/v1/models`).
4. In a temp dir create `m.py` with a one-line bug, e.g.
   `def add(a, b): return a - b`, and ask the agent non-interactively to fix
   it with stdin closed (`... < /dev/null`). Check the file was fixed.
5. Check the "Agent Gateway" log shows the agent's requests with status 200.
6. Apply `unplan()` the same way, then diff every config file against the
   backup. Byte-identical is the goal; explain any difference. Restore from
   the backup if anything is off, and delete the generated `.bak` files.

## 5. Contract check and docs

- Add a runner for the agent in `test-live/contracts/` following the
  existing ones, record its shape with
  `node test-live/contracts/check.mjs --only <id> --update`, and make sure
  `node test-live/contracts/versions.mjs` lists it.
- README: add a row to the "Supported agents" table (user-facing words).
- `docs/reference.md`: add the files it writes under "Files written by
  Configure Coding Agents", and a "Which agents use it" row for web search if
  relevant.
- CHANGELOG: one user-facing line.
