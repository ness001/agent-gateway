# Agent instructions

Read CONTRIBUTING.md before changing or building this extension.
Preserve unrelated changes and active user sessions; use an isolated worktree
when another task is editing the same checkout.

## Completion requires local installation

After each completed change to this repository, build and install the updated
Agent Gateway extension in the user's local VS Code before reporting completion.
This is standing authorization for the local build and installation; do not ask
again unless the user changes the scope. An explicit request not to install wins.
This does not authorize Marketplace publication or changes to other extensions.

1. Run focused unit tests and tests for the changed scenario. Do not run the full
   local suite unless requested or a specific risk requires it.
2. Build and package the final source revision, then install the release VSIX for
   the current user. Follow scripts/install.ps1 and CONTRIBUTING.md; do not install
   the side-by-side dev variant unless requested. Keep dependency and security
   policies intact. Never package unrelated unfinished edits.
3. Verify installation succeeded and the installed dist/extension.cjs SHA-256
   matches the bundle just built. A matching version number alone is insufficient.
4. Report the installed source revision and validation results. Distinguish
   installed files from the running extension: preserve active sessions and tell
   the user to run Developer: Reload Window if activation requires a reload.
5. If build, tests, or installation fail, retain completed work and report the
   blocker. Do not claim the extension is updated or the task is complete.

Documentation-only changes still follow this installation rule unless the user
explicitly opts out. Do not commit generated VSIX files or build output.
