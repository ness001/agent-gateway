---
name: fix-client-contract-break
description: Fix a coding agent that starts failing against the gateway after an agent update, e.g. 400 "Tool type X is not supported" or "unsupported input item type". Use when an agent sends a request shape the gateway does not understand.
---

# Fix a client contract break

Agents add tools, input items and fields without notice. Accept the new
shape, keep the round-trip correct, and never fail a whole request over an
optional feature.

## 1. Reproduce

- Get the exact error and `request_id` from the agent output or the error log
  (**Status** > **Open error log**); find the line in the "Agent Gateway" log
  (see `dev-loop`).
- Note the agent version (`node test-live/contracts/versions.mjs`) and rerun
  the failing command against the dev build (port 24445).

## 2. Capture the request shape

- Preferred: `node test-live/contracts/check.mjs --only <agent>` records the
  agent's request shape and diffs it against the snapshot; the diff shows the
  new tool type, item type or field.
- Otherwise write a tiny local logging proxy in front of the gateway that
  prints structure only: keys, `type` values, array lengths. Never log prompt
  text, tool arguments, file contents, URLs or keys, and never commit captured
  bodies.

## 3. Read the public reference

Look up the new type before coding:

- OpenAI Responses: the API reference for creating a response (request body,
  input item types, tools); the `.md` versions of the pages read best.
- Anthropic Messages: Messages API and tool-use docs (server tools, content
  blocks).
- Gemini: `generateContent` reference (parts, tools).

Note required fields, the matching output item, and whether it can work
through the VS Code Language Model API at all.

## 4. Implement

Code lives in `src/protocol/<api>/` (`anthropic/`, `openai/chat`,
`openai/responses`, `gemini/`): `decode.ts` for requests, `encode.ts` for
responses; `src/protocol/index.ts` routes.

- Mappable (a function-like or custom tool, an input item carrying text):
  decode it into the core request and encode the matching output item so the
  agent gets its own type back. Replayed history must decode too.
- Built-in tool that cannot run through the LM API: drop it with one info log
  line naming only the type, like the `dropped` list in
  `openai/responses/decode.ts`. Reject only when the request cannot be
  answered correctly without it.
- Unknown history item: drop with an info log rather than a 400, unless
  dropping changes meaning (e.g. a tool call without its output).
- Log types and counts, never content.

## 5. Test and verify

- Add tests under `src/test/protocol/<api>/` built from the captured shape
  with synthetic values: decode, encode, history replay round-trip.
- `pwsh -NoProfile -File scripts/run-tests.ps1`.
- `pwsh -NoProfile -File scripts/install.ps1 -Dev`, rerun the agent on the
  original task, confirm status 200 in the log.
- `node test-live/contracts/check.mjs --only <agent> --update`, review the
  snapshot diff and commit it with the fix.
- CHANGELOG: a user-facing line, e.g. "Codex: requests that include the new
  X tool no longer fail."
