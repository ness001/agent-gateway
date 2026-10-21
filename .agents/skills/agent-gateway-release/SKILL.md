---
name: agent-gateway-release
description: Release a new version of the Agent Gateway VS Code extension, including version and changelog updates, exact-commit CI checks, tag-driven publication, and verified local installation. Use for Agent Gateway release, publish, or version-tag requests; not for build-only updates or other repositories.
author: Li Liang
---

# Release Agent Gateway

## Scope and checkout

- An explicit request to release authorizes the repository's normal release
  workflow, including its configured publication destinations. A request to
  prepare a release or create this skill does not authorize publication.
- Use the repository checkout containing this skill, or the user-selected
  checkout. Verify `git remote -v`, branch, status and worktrees before changing
  anything. Use an isolated worktree when another task has unfinished changes.
- Read the current `AGENTS.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, and `.claude/skills/live-verify/SKILL.md`.
  Repository instructions and live workflow definitions take precedence over
  examples below. Preserve active sessions and unrelated work.

## Prepare the version

1. Fetch the default branch and tags. Inspect `package.json`, releases and tags;
   use the user's version, or choose the next unused patch version for an
   unspecified small release. Do not reuse or move a published tag.
2. Review commits since the previous release. Update `package.json` and add a
   user-facing `CHANGELOG.md` section. Do not describe unmerged work as released.
   Update other version-bearing files only where the repository requires it.
3. Keep publisher credentials in GitHub secrets. Inspect secret names or workflow
   outcomes only, never secret values. Do not pass a publisher token through chat
   or a local command.

## Validate and merge

- Use the repository's package manager, lockfile and declared Node version range.
  Run focused tests for the changed behavior, type checks, production bundle load
  and bundle budget checks. Do not duplicate the full local suite when the user
  requested focused tests; required CI still applies.
- Before tagging, complete the live contract/soak checks required by the release
  guide against a dev build of the release candidate. Read the harness first:
  identify scratch directories, agent configuration changes and restoration.
  Do not test by disrupting the current gateway/session. If a required check is
  unavailable or fails, stop before tagging and explain the gap; do not silently
  treat unit tests as a replacement. Obtain an explicit waiver if needed.
- If a package manager reports blocked dependency build scripts, retain the
  security policy. Do not approve everything or change registries to bypass it.
  Already-installed tools can run equivalent focused checks without executing
  the blocked scripts; report any remaining build or packaging limitation.
- Commit only release files, push the task branch, create/reuse its PR, and merge
  after required checks pass. Fast-forward the matching local default branch.
- **Wait for successful CI on the exact merged commit.** A passing PR build is
  not proof that its squash-merge commit passed. Verify both `headSha` and
  `conclusion` with `gh run view`. Do not tag on an older success.

Useful read-only commands, from the verified checkout:

```powershell
gh release list --limit 5
git tag --sort=-version:refname
gh run list --workflow ci.yml --commit $sha --json databaseId,headSha,status,conclusion
gh run view $runId --json headSha,status,conclusion
gh run watch $runId --exit-status --interval 30
```

## Publish once

1. Verify the worktree is clean, HEAD is the validated merge commit, and the
   version matches the intended tag. If the tag already exists, inspect its SHA
   and release status rather than creating, deleting or pushing it again.
2. For a new version, create and push only its exact tag:

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
git tag $tag $sha
# Check the exit code before pushing.
git push origin $tag
```

3. Find the release workflow run for that SHA/tag and wait for completion. The
   current workflow creates a GitHub release and VSIX, publishes to VS Code
   Marketplace when `VSCE_PAT` exists, and to Open VSX when `OVSX_PAT` exists.
   Recheck these conditions each time; missing secrets mean skipped publication,
   not successful publication.
4. Verify the release is not a draft, the asset is uploaded and nonempty, the tag
   points to the intended SHA, and each publication step succeeded or was skipped.
   If publication partially fails, report which destinations completed. Do not
   retag, bump again, delete a release, or republish successful destinations by
   reflex. Diagnose the failed step before choosing a scoped recovery.

## Install the published artifact locally

- Download the VSIX from the verified release into an unused local path using
  `gh release download`. Prefer this exact artifact over rebuilding: the bundle
  embeds build time, so two builds of the same commit can have different hashes.
- If the release asset has a SHA-256 digest, verify the downloaded file against
  it. Install with `code --install-extension <absolute-vsix-path> --force` and
  check the exit code. Confirm the installed extension ID and version with
  `code --list-extensions --show-versions`.
- Open the VSIX as a ZIP and hash `extension/dist/extension.cjs`; compare it with
  the actual installed bundle. Do not compare the installed README directly to
  source bytes: VSCE can rewrite relative documentation links. Compare it to the
  packaged README if verification is needed.
- Keep generated packages/build output out of Git. Verify remote tag, default
  branch and local commit before reporting completion.
- Installation does not prove activation. Preserve active sessions and tell the
  user to run **Developer: Reload Window** when a reload is needed; do not claim
  a live request succeeded without testing it.

## Completion report

Report the version and release link, source SHA, publication result per registry,
local installation/hash verification, tests and any waived or unverified checks.
Include changed source files. If any required stage is incomplete, state that
explicitly rather than declaring the entire release successful.
