---
name: codex-source-diagnosis
author: Li Liang
description: Trace Codex session, automation, tool-history, and custom-provider failures from local evidence to pinned openai/codex source and tests. Use to identify who created an unexpected protocol item or where a field changed, not for general Codex setup or unrelated repository bugs.
---

# Codex source diagnosis

Find the producer of the failing data before assigning blame to a gateway,
model, migration, or old session. A compatibility fix and a proven root cause
are separate outcomes.

## Evidence-first workflow

1. **Define the failure boundary.** Record the exact error, time zone, operation,
   client version, and provider route. Distinguish client validation, gateway
   decoding, provider rendering, upstream rejection, and response streaming.
   For OpenAI product or API facts, use the available openai-docs skill first.
   This does not replace inspecting the actual local event.
2. **Find the matching artifact.** Prefer a supplied request export or session
   identifier. Search the configured Codex home, including `sessions` and
   `archived_sessions`; a missing active file does not mean lost history.
   Parse JSONL and return only relevant structural fields: timestamp, item
   type, field presence/type, tool name/namespace, and correlation identifiers.
   Inspect content locally only when needed to classify its source. Do not
   dump unrelated conversations, secrets, or full tool output.
3. **Reconstruct provenance.** Compare the saved event with nearby events and
   the failed outgoing request. An input-array index is not a JSONL line number.
   Separate absent, null, empty, and wrong-type fields. Distinguish item `id`
   from invocation `call_id`; search for the actual matching call rather than
   assuming a result lost its link. Determine whether the item was generated
   by the model, a tool execution, an external notification, or a scheduler.
4. **Search upstream precisely.** Search public `openai/codex` issues using the
   error signature and schema terms, not private payloads or identifiers.
   Issues and comments are leads, not authoritative proof. Read the relevant
   discussion, then verify its claims in source and tests at a fixed commit.
   Use the installed release's source when available; otherwise disclose the
   version gap. Read [source navigation](references/source-navigation.md)
   when tracing producers, serialization, replay, or provider compatibility.
5. **Trace both creation and consumption.** Follow the input API/event through
   item construction, serialization, history normalization, and outbound request
   assembly. Look for explicit `None`, optional fields, serialization omission,
   generated IDs, and tests that intentionally permit the observed shape.
   Do not assume the absence of a field is corruption: an external event may
   intentionally have no preceding model call.
6. **Test the causal claim.** Reproduce with the smallest privacy-safe fixture
   through the actual decoder or request builder. Compare the failing and
   corrected behavior. A mock proves the handling of an injected condition,
   not that the condition occurred in production. For a suspected downstream
   transformation, compare before/after artifacts or use a bounded local
   reproduction of that transformation. Do not generate a new live automation
   or send a private transcript upstream merely to reproduce a failure.
7. **Report the chain and limits.** State producer -> representation -> consumer
   assumption -> failure, with pinned source links and local evidence. Separate
   observed facts, source-supported explanation, hypotheses, and unknowns.
   Correct earlier claims when stronger evidence changes the explanation.
   If evidence is incomplete, name the smallest missing artifact rather than
   claiming a root cause from a matching issue alone.

## Repair boundary

Default to read-only diagnosis unless a fix is requested. If authorized, choose
an upstream producer fix only when the item violates that producer's contract.
If the producer intentionally supports a representation that the destination
cannot accept, normalize at the compatibility boundary instead.

Preserve content and provenance. Never fabricate a matching call ID, reuse an
unrelated invocation, re-execute a tool, silently drop an external event, or
rewrite saved sessions as a routine repair. Keep original history intact and
use a per-request copy. Document any loss of structured semantics.

Use focused regression tests, including normal paired calls, standalone events,
wrong-type fields, replay, and privacy-safe diagnostics as relevant. Report
source changes, installed build, activated runtime, and live validation as
separate states. Do not publish issue reports, logs, or local user data without
specific authorization.
