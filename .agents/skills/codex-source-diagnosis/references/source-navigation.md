# Source navigation

Use https://github.com/openai/codex as the source repository, but verify the
current tree before opening paths. Refactors can move files. The paths below
are search leads, not guarantees for every release.

## Locate a revision and files

- Identify the installed Codex/app-server version using available version
  metadata. Resolve a matching release/tag to a commit where possible.
- Inspect a repository tree at that commit, or search a local source checkout.
  Narrow by symbol names from the error, item shape, or issue discussion.
- Useful read-only GitHub REST routes are
  `/repos/openai/codex/git/trees/{commit}?recursive=1` and
  `/repos/openai/codex/issues/{number}/comments`. Check truncation and pagination.
- Pin citations as `https://github.com/openai/codex/blob/{commit}/{path}#Lx-Ly`.
  Verify line numbers against the fetched file. Never cite moving `main` as
  proof of behavior in an older installed version.
- Public issue statements are not maintainer confirmation. Verify the source
  and tests independently. Do not evade access denials or change authentication
  identities to work around them; use permitted public evidence or report gaps.

## Trace map

| Question | Search leads |
| --- | --- |
| What can the desktop client send? | `TurnStartParams`, `TurnToolOutput`, `toolOutput`; app-server protocol schemas |
| Who creates the item? | `FunctionCallOutput`, `call_id: None`, `tool_output`; request processors |
| Why does a field disappear from JSON? | `Option`, `skip_serializing_if`, custom serializer; protocol models |
| Where does an item ID come from? | `id_prefix`, `assign_missing_response_item_id`, `ResponseItemId` |
| Is the shape intentional? | Round-trip tests, external-event tests, protocol comments |
| What happens on resume? | Session turn input, history reconstruction, `normalize_history`, `remove_orphan_outputs` |
| Is it adapted for custom providers? | Client request assembly, provider capability flags, HTTP versus WebSocket serialization |

Common directories include `codex-rs/protocol`, `codex-rs/app-server-protocol`,
`codex-rs/app-server`, and `codex-rs/core`. Locate the exact files in the chosen
revision instead of repeatedly guessing obsolete paths.

## Important distinctions

- **Item ID versus call ID:** an item ID identifies a saved record. It does not
  prove the existence of a corresponding model invocation.
- **Standalone event versus broken pair:** a named external notification can be
  represented as an output without a preceding call. Verify the producer's
  contract before calling it an orphan or deleted history.
- **Intentional omission versus data loss:** explicit optional fields and a
  round-trip test can explain omission by design. Only boundary comparisons
  establish that a field was removed in transit.
- **Old session versus old event:** an old task can receive a new scheduled event.
  Compare event timestamps and producers, not just the task creation time.
- **Compatibility versus corruption:** one gateway may accept a representation
  another rejects. This does not establish that the first gateway created it.
- **Reproduction versus runtime proof:** a local source experiment demonstrates
  a mechanism. It does not establish that the production request took that
  path without matching evidence.

## Minimal result

Give the exact confirmed failure, a short evidence timeline, the producer and
consumer contracts, and pinned source/test links. State any installed-version
gap. For unresolved cases, request only the missing item shape, request export,
or boundary observation needed next. Keep private artifacts local and never
store case-specific histories, IDs, or dated outcomes in this skill.
