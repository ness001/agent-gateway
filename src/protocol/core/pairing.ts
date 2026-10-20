import type {
  CoreLogger,
  Part,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Turn,
} from "./types";

export type RepairKind =
  | "missing_result"
  | "orphan_result"
  | "reordered"
  | "duplicate";

export interface PairingRepair {
  kind: RepairKind;
  toolName: string;
  callId: string;
  /** Index of the message (turn) in the input list the repair refers to. */
  messageIndex: number;
}

export interface PairingOutcome {
  turns: Turn[];
  repairs: PairingRepair[];
}

export const MISSING_RESULT_TEXT = "tool result missing";

interface CallInfo {
  name: string;
  turnIndex: number;
}

interface LocatedResult {
  part: ToolResultPart;
  turnIndex: number;
}

function orphanToText(part: ToolResultPart): TextPart {
  const body = part.content
    .map((c) => (c.type === "text" ? c.text : `[image ${c.mime}]`))
    .join("\n");
  const label = part.name ?? part.callId;
  return { type: "text", text: `[tool result ${label}]\n${body}` };
}

function syntheticResult(call: ToolCallPart): ToolResultPart {
  return {
    type: "toolResult",
    callId: call.id,
    name: call.name,
    content: [{ type: "text", text: MISSING_RESULT_TEXT }],
    isError: true,
  };
}

/**
 * Repairs tool-call/tool-result pairing. Every assistant turn with tool calls
 * is followed by a user turn that starts with exactly one result per call, in
 * call order. Pure: the input is not mutated.
 */
export function repairPairing(input: readonly Turn[]): PairingOutcome {
  const repairs: PairingRepair[] = [];

  // Pass 1: register calls (first occurrence of an id wins).
  const calls = new Map<string, CallInfo>();
  input.forEach((turn, i) => {
    if (turn.role !== "assistant") {
      return;
    }
    for (const p of turn.parts) {
      if (p.type === "toolCall" && !calls.has(p.id)) {
        calls.set(p.id, { name: p.name, turnIndex: i });
      }
    }
  });

  // Pass 2: classify results; keep first valid one per call id.
  const kept = new Map<string, LocatedResult>();
  const orphanIndex = new Set<ToolResultPart>();
  input.forEach((turn, i) => {
    for (const p of turn.parts) {
      if (p.type !== "toolResult") {
        continue;
      }
      const call = calls.get(p.callId);
      if (!call || call.turnIndex >= i) {
        orphanIndex.add(p);
        repairs.push({
          kind: "orphan_result",
          toolName: p.name ?? call?.name ?? "",
          callId: p.callId,
          messageIndex: i,
        });
      } else if (kept.has(p.callId)) {
        repairs.push({
          kind: "duplicate",
          toolName: call.name,
          callId: p.callId,
          messageIndex: i,
        });
      } else {
        kept.set(p.callId, { part: p, turnIndex: i });
      }
    }
  });

  // Pass 3: rebuild.
  const out: Turn[] = [];
  for (let i = 0; i < input.length; i++) {
    const turn = input[i];
    const rest: Part[] = [];
    for (const p of turn.parts) {
      if (p.type !== "toolResult") {
        rest.push(p);
      } else if (orphanIndex.has(p)) {
        rest.push(orphanToText(p));
      }
    }
    const hadResults = turn.parts.some((p) => p.type === "toolResult");
    if (rest.length > 0 || !hadResults) {
      out.push({ role: turn.role, parts: rest });
    }

    if (turn.role !== "assistant") {
      continue;
    }
    const ownCalls = turn.parts.filter(
      (p): p is ToolCallPart =>
        p.type === "toolCall" && calls.get(p.id)?.turnIndex === i,
    );
    if (ownCalls.length === 0) {
      continue;
    }

    const expectedIndex = i + 1;
    const nextResultsInPlace =
      expectedIndex < input.length
        ? input[expectedIndex].parts.filter(
            (p): p is ToolResultPart =>
              p.type === "toolResult" && kept.get(p.callId)?.part === p,
          )
        : [];
    let position = 0;
    const results: ToolResultPart[] = ownCalls.map((call) => {
      const found = kept.get(call.id);
      if (!found) {
        repairs.push({
          kind: "missing_result",
          toolName: call.name,
          callId: call.id,
          messageIndex: i,
        });
        return syntheticResult(call);
      }
      const inPlace =
        found.turnIndex === expectedIndex &&
        nextResultsInPlace[position] === found.part;
      if (found.turnIndex === expectedIndex) {
        position++;
      }
      if (!inPlace) {
        repairs.push({
          kind: "reordered",
          toolName: call.name,
          callId: call.id,
          messageIndex: found.turnIndex,
        });
      }
      return found.part;
    });

    const next = input[expectedIndex];
    if (next && next.role === "user") {
      // Prepend into the (possibly dropped) next user turn.
      const nextRest: Part[] = [];
      for (const p of next.parts) {
        if (p.type !== "toolResult") {
          nextRest.push(p);
        } else if (orphanIndex.has(p)) {
          nextRest.push(orphanToText(p));
        }
      }
      out.push({ role: "user", parts: [...results, ...nextRest] });
      i++;
    } else {
      out.push({ role: "user", parts: results });
    }
  }

  return { turns: out, repairs };
}

/** Writes one warning line per repair. Never logs arguments or content. */
export function logRepairs(
  repairs: readonly PairingRepair[],
  log: Pick<CoreLogger, "warn">,
  requestId: string | undefined,
  protocol: string,
): void {
  for (const r of repairs) {
    log.warn(
      `[${requestId ?? "-"}] ${protocol} tool pairing repair kind=${r.kind} tool=${r.toolName} callId=${r.callId} messageIndex=${r.messageIndex}`,
    );
  }
}

/**
 * Gemini: assigns ids to calls without one and matches id-less results to the
 * closest preceding assistant turn's calls by name, in order.
 */
export function inferGeminiCallIds(input: readonly Turn[]): Turn[] {
  let lastCalls: ToolCallPart[] = [];
  const used = new Set<string>();
  return input.map((turn, ti) => {
    if (turn.role === "assistant") {
      let n = 0;
      const parts = turn.parts.map((p): Part => {
        if (p.type !== "toolCall") {
          return p;
        }
        n++;
        return p.id ? p : { ...p, id: `gemini_call_${ti}_${n - 1}` };
      });
      const newCalls = parts.filter(
        (p): p is ToolCallPart => p.type === "toolCall",
      );
      if (newCalls.length > 0) {
        lastCalls = newCalls;
        used.clear();
      }
      return { role: turn.role, parts };
    }
    const parts = turn.parts.map((p): Part => {
      if (p.type !== "toolResult") {
        return p;
      }
      if (p.callId) {
        used.add(p.callId);
        return p;
      }
      const match = lastCalls.find((c) => c.name === p.name && !used.has(c.id));
      if (!match) {
        return p;
      }
      used.add(match.id);
      return { ...p, callId: match.id };
    });
    return { role: turn.role, parts };
  });
}
