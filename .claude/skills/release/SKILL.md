---
name: release
description: Cut an Agent Gateway release (version bump, changelog, checks, tag). Use when asked to release, publish or tag a new version.
---

# Release

## 1. Prepare

- Bump `version` in `package.json`; the tag must be exactly `v<version>`.
- Add a `CHANGELOG.md` section for the version in user-facing words: what
  changed for someone using an agent, not refactors or file names (see
  `docs-style`).
- Update README and `docs/reference.md` if behaviour or settings changed.

## 2. Check

```powershell
pwsh -NoProfile -File scripts/run-tests.ps1
```

Then run `live-verify` (contract checks and soak) against a dev build of the
release commit. Do not tag with a failing scenario unless it is a known
harness issue you have written down.

## 3. Tag

Commit, then, with the user's go-ahead (this publishes):

```bash
git tag v<version>
git push origin v<version>
```

## What `.github/workflows/release.yml` does

On a `v*` tag it does not rerun the tests. It stops unless the CI workflow
passed on the tagged commit (so push to `main` and wait for CI before tagging),
checks the tag matches `package.json`, installs, runs the production build and
bundle budget, packages `agent-gateway-v<version>.vsix`, creates a
GitHub release with the VSIX and generated notes, then publish to the VS Code
Marketplace if the `VSCE_PAT` secret is set and to Open VSX if `OVSX_PAT` is
set. Each publish step is skipped when its secret is missing.

## Tokens

Never ask for, read, store or paste the user's publisher tokens. The user
adds `VSCE_PAT` / `OVSX_PAT` as repository secrets and runs `vsce login` or
any manual publish themselves.
