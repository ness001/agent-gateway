---
name: docs-style
description: Decide where documentation goes and how to write it. Use when editing README.md, CHANGELOG.md, docs/reference.md or CONTRIBUTING.md, or adding any user-visible text.
---

# Docs style

## Where content goes

- `README.md` is the Marketplace page. User-facing only: features, getting
  started, supported agents table, commands, settings, sharing models, web
  search, troubleshooting, privacy and security. No build steps or internals.
- `CHANGELOG.md`: user-facing changes per version, described by what users
  notice. No file names, refactors or test changes.
- `docs/reference.md`: technical reference: endpoints, manual client setup,
  files written per agent, models and aliases, web search engines and limits,
  logs and request IDs, remote upstreams.
- `CONTRIBUTING.md`: contributors: build, tests, live checks, code layout,
  rules, CI and releases.

## Rules

- No internal registry URLs, personal paths, usernames, machine names, tokens
  or keys in any tracked file, including tests and fixtures. Use placeholders
  like `~`, `%APPDATA%`, `<session>`.
- Keep privacy statements accurate: prompts, request bodies, tool arguments,
  search queries, URLs, page text and keys are never logged. If a change logs
  something new, check it against this list and update README "Privacy and
  security" and `docs/reference.md` "Logs and request IDs" as needed.
- README settings must match `contributes.configuration` in `package.json`.
- README agents table must match `src/clients/index.ts`.
- Short sentences, present tense, bold for UI labels (**Configure Coding
  Agents**), backticks for paths, settings and commands.
- Format with `pnpm exec prettier --write <file>`.
