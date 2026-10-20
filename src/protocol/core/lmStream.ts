import type { CoreEvent, EndReason, NormalizedUsage } from "./types";
import { reachedLimit, usageFromPart } from "./usage";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function ctorName(v: object): string {
  return (v as { constructor?: { name?: string } }).constructor?.name ?? "";
}

function joinValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((s) => typeof s === "string")) {
    return value.join("");
  }
  return undefined;
}

/**
 * Duck-typed thinking part (proposed `LanguageModelThinkingPart`): a `value`
 * string (or string array) plus either a Thinking constructor name or an
 * `id`/`metadata` field that a plain text part does not have.
 */
export function asThinking(
  part: unknown,
): { text: string; signature?: string } | undefined {
  if (!isRecord(part) || "callId" in part) {
    return undefined;
  }
  const text = joinValue(part.value);
  if (text === undefined) {
    return undefined;
  }
  const named = /Thinking/.test(ctorName(part));
  if (!named && !("metadata" in part) && !("id" in part)) {
    return undefined;
  }
  const meta = isRecord(part.metadata) ? part.metadata : undefined;
  const sig = meta?.signature;
  return typeof sig === "string" ? { text, signature: sig } : { text };
}

function asText(part: unknown): string | undefined {
  if (!isRecord(part) || typeof part.value !== "string") {
    return undefined;
  }
  return part.value;
}

function asToolCall(
  part: unknown,
): { id: string; name: string; input: object } | undefined {
  if (
    !isRecord(part) ||
    typeof part.callId !== "string" ||
    typeof part.name !== "string"
  ) {
    return undefined;
  }
  return {
    id: part.callId,
    name: part.name,
    input: isRecord(part.input) ? part.input : {},
  };
}

/** Maps one stream part to an event, or undefined (usage/unknown/empty). */
export function classifyPart(part: unknown): CoreEvent | undefined {
  const call = asToolCall(part);
  if (call) {
    return { e: "toolCall", ...call };
  }
  const thinking = asThinking(part);
  if (thinking) {
    return thinking.signature !== undefined
      ? { e: "thinking", delta: thinking.text, signature: thinking.signature }
      : { e: "thinking", delta: thinking.text };
  }
  const text = asText(part);
  return text ? { e: "text", delta: text } : undefined;
}

export interface StreamOptions {
  /** Client output limit, used only to prove a length finish. */
  maxOutputTokens?: number;
}

export function endReason(
  sawTool: boolean,
  usage: NormalizedUsage | undefined,
  limit?: number,
): EndReason {
  if (sawTool) {
    return "tool";
  }
  return reachedLimit(usage, limit) ? "length" : "stop";
}

/** response.stream parts -> CoreEvents, ending with exactly one `end`. */
export async function* lmStreamToEvents(
  stream: AsyncIterable<unknown>,
  opts: StreamOptions = {},
): AsyncGenerator<CoreEvent> {
  let usage: NormalizedUsage | undefined;
  let sawTool = false;
  for await (const part of stream) {
    const u = usageFromPart(part);
    if (u) {
      usage = u;
      continue;
    }
    if (isRecord(part) && "mimeType" in part) {
      continue; // other data parts are ignored
    }
    const ev = classifyPart(part);
    if (!ev) {
      continue;
    }
    if (ev.e === "toolCall") {
      sawTool = true;
    }
    yield ev;
  }
  const reason = endReason(sawTool, usage, opts.maxOutputTokens);
  yield usage ? { e: "end", reason, usage } : { e: "end", reason };
}
