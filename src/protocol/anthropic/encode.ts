import { ERROR_TABLE } from "../core/errors";
import { newId } from "../core/ids";
import type { Encoder, TurnSink } from "../core/runTurn";
import type { CoreEvent, EndReason, NormalizedUsage } from "../core/types";
import { toAnthropicUsage } from "../core/usage";
import { anthropicOutput } from "../hosted";
import type { CitationRegistry } from "../hosted/citations";
import type {
  WireCitation,
  WireContentBlock,
  WireDeltaUsage,
  WireMessage,
  WireStopReason,
  WireStreamEvent,
  WireUsage,
} from "./wire";

export function stopReasonFor(reason: EndReason): WireStopReason {
  switch (reason) {
    case "tool":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stopSequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    case "stop":
      return "end_turn";
  }
}

/** Full 8-key usage. Absent cache counts report 0. */
export function wireUsage(
  u: NormalizedUsage | undefined,
  serviceTier: string | null,
  searches = 0,
  fetches = 0,
): WireUsage {
  const a = toAnthropicUsage(u, searches, fetches);
  return {
    cache_creation: null,
    cache_creation_input_tokens: a.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: a.cache_read_input_tokens ?? 0,
    inference_geo: null,
    input_tokens: a.input_tokens,
    output_tokens: a.output_tokens,
    server_tool_use: a.server_tool_use ?? null,
    service_tier: serviceTier,
  };
}

export function deltaUsage(
  u: NormalizedUsage | undefined,
  searches = 0,
  fetches = 0,
): WireDeltaUsage {
  const w = wireUsage(u, null, searches, fetches);
  return {
    input_tokens: w.input_tokens,
    output_tokens: w.output_tokens,
    cache_creation_input_tokens: w.cache_creation_input_tokens,
    cache_read_input_tokens: w.cache_read_input_tokens,
    server_tool_use: w.server_tool_use,
  };
}

type OpenKind = "text" | "thinking";

export interface AnthropicEncoderOptions {
  echoModel: string;
  requestId: string;
  /** Message id; generated when omitted. */
  id?: string;
  /** Hosted search citation registry (stable [n] indices). */
  citations?: CitationRegistry;
}

/**
 * CoreEvents -> Anthropic stream events, in the documented order:
 * message_start, per block start/delta/stop, message_delta, message_stop.
 * The same events feed the non-stream aggregator ({@link collectMessage}).
 */
export class AnthropicEncoder implements Encoder<WireStreamEvent> {
  readonly id: string;
  private started = false;
  private done = false;
  private next = 0;
  private open: { kind: OpenKind; index: number; text: string } | undefined;
  /** Internal hosted call id -> srvtoolu_ id. */
  private readonly hostedIds = new Map<string, string>();
  /** Internal hosted call id -> fetched URL (web_fetch calls only). */
  private readonly fetchUrls = new Map<string, string>();
  private searches = 0;
  private fetches = 0;

  constructor(private readonly o: AnthropicEncoderOptions) {
    this.id = o.id ?? newId("anthropicMessage");
  }

  onEvent(ev: CoreEvent, sink: TurnSink<WireStreamEvent>): void {
    if (this.done) {
      return;
    }
    switch (ev.e) {
      case "text":
        if (!ev.delta) {
          return;
        }
        this.ensureBlock("text", sink);
        if (!ev.sources) {
          // The appended Sources list is not scanned for citations.
          this.open!.text += ev.delta;
        }
        this.write(sink, {
          type: "content_block_delta",
          index: this.open!.index,
          delta: { type: "text_delta", text: ev.delta },
        });
        return;
      case "thinking":
        if (!ev.delta && ev.signature === undefined) {
          return;
        }
        this.ensureBlock("thinking", sink);
        if (ev.delta) {
          this.write(sink, {
            type: "content_block_delta",
            index: this.open!.index,
            delta: { type: "thinking_delta", thinking: ev.delta },
          });
        }
        if (ev.signature !== undefined) {
          this.write(sink, {
            type: "content_block_delta",
            index: this.open!.index,
            delta: { type: "signature_delta", signature: ev.signature },
          });
          this.closeBlock(sink);
        }
        return;
      case "toolCall": {
        this.start(sink);
        this.closeBlock(sink);
        const index = this.next++;
        this.write(sink, {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: ev.id,
            caller: { type: "direct" },
            name: ev.name,
            input: {},
          },
        });
        this.write(sink, {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(ev.input ?? {}),
          },
        });
        this.write(sink, { type: "content_block_stop", index });
        return;
      }
      case "end":
        this.start(sink);
        this.closeBlock(sink);
        this.write(sink, {
          type: "message_delta",
          delta: {
            container: null,
            stop_details: null,
            stop_reason: stopReasonFor(ev.reason),
            stop_sequence:
              ev.reason === "stopSequence" ? (ev.stopSeq ?? null) : null,
          },
          usage: deltaUsage(ev.usage, this.searches, this.fetches),
        });
        this.write(sink, { type: "message_stop" });
        this.done = true;
        return;
      case "error":
        this.write(sink, {
          type: "error",
          error: {
            type: ERROR_TABLE[ev.err.kind].anthropicType,
            message: ev.err.message,
          },
          request_id: this.o.requestId,
        });
        this.done = true;
        return;
      case "hostedCall": {
        // server_tool_use with a srvtoolu_ id.
        this.start(sink);
        this.closeBlock(sink);
        const id = newId("anthropicServerToolUse");
        this.hostedIds.set(ev.id, id);
        const index = this.next++;
        const block =
          ev.kind === "fetch"
            ? anthropicOutput.serverFetchUseBlock(id, ev.url ?? "")
            : anthropicOutput.serverToolUseBlock(id, ev.query ?? "");
        if (ev.kind === "fetch") {
          this.fetchUrls.set(ev.id, ev.url ?? "");
        }
        this.write(sink, {
          type: "content_block_start",
          index,
          content_block: { ...block, input: {} as { query: string } },
        });
        this.write(sink, {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
        this.write(sink, { type: "content_block_stop", index });
        return;
      }
      case "hostedResult": {
        this.start(sink);
        this.closeBlock(sink);
        const toolUseId = this.hostedIds.get(ev.callId) ?? ev.callId;
        const fetchUrl = this.fetchUrls.get(ev.callId);
        const index = this.next++;
        if (fetchUrl !== undefined) {
          if (!ev.error) {
            this.fetches++;
          }
          this.write(sink, {
            type: "content_block_start",
            index,
            content_block: anthropicOutput.webFetchToolResultBlock(
              toolUseId,
              fetchUrl,
              ev.page,
              ev.error,
            ),
          });
          this.write(sink, { type: "content_block_stop", index });
          return;
        }
        if (!ev.error) {
          this.searches++;
        }
        this.write(sink, {
          type: "content_block_start",
          index,
          content_block: anthropicOutput.webSearchToolResultBlock(
            toolUseId,
            ev.sources,
            ev.error,
          ),
        });
        this.write(sink, { type: "content_block_stop", index });
        return;
      }
    }
  }

  /** Terminates a stream that ended without an `end` event. */
  finish(sink: TurnSink<WireStreamEvent>): void {
    if (!this.done) {
      this.onEvent({ e: "end", reason: "stop" }, sink);
    }
  }

  private write(sink: TurnSink<WireStreamEvent>, ev: WireStreamEvent): void {
    sink.write(ev);
  }

  private start(sink: TurnSink<WireStreamEvent>): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.write(sink, {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.o.echoModel,
        container: null,
        content: [],
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: wireUsage(undefined, "standard"),
      },
    });
  }

  private ensureBlock(kind: OpenKind, sink: TurnSink<WireStreamEvent>): void {
    this.start(sink);
    if (this.open?.kind === kind) {
      return;
    }
    this.closeBlock(sink);
    const index = this.next++;
    this.open = { kind, index, text: "" };
    this.write(sink, {
      type: "content_block_start",
      index,
      content_block:
        kind === "text"
          ? { type: "text", text: "", citations: null }
          : { type: "thinking", thinking: "", signature: "" },
    });
  }

  /** Citations for `[n]` markers in a text block (registry index n-1). */
  private citationsFor(text: string): WireCitation[] {
    const reg = this.o.citations;
    if (!reg?.size) {
      return [];
    }
    const all = anthropicOutput.searchCitations(reg.all());
    const seen = new Set<number>();
    const out: WireCitation[] = [];
    for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
      const i = Number(m[1]) - 1;
      if (all[i] && !seen.has(i)) {
        seen.add(i);
        out.push(all[i]);
      }
    }
    return out;
  }

  private closeBlock(sink: TurnSink<WireStreamEvent>): void {
    if (this.open?.kind === "text") {
      for (const citation of this.citationsFor(this.open.text)) {
        this.write(sink, {
          type: "content_block_delta",
          index: this.open.index,
          delta: { type: "citations_delta", citation },
        });
      }
    }
    if (this.open) {
      this.write(sink, { type: "content_block_stop", index: this.open.index });
      this.open = undefined;
    }
  }
}

/** One SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function sseFrame(ev: WireStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export type Collected =
  | { ok: true; message: WireMessage }
  | {
      ok: false;
      error: Extract<WireStreamEvent, { type: "error" }>;
    };

/** Aggregates stream events into the non-stream message body. */
export function collectMessage(
  events: readonly WireStreamEvent[],
  fallback: { id: string; model: string },
): Collected {
  let message: WireMessage | undefined;
  const blocks: WireContentBlock[] = [];
  const json = new Map<number, string>();
  for (const ev of events) {
    switch (ev.type) {
      case "message_start":
        message = { ...ev.message, content: [] };
        break;
      case "content_block_start":
        blocks[ev.index] = { ...ev.content_block };
        break;
      case "content_block_delta": {
        const b = blocks[ev.index];
        const d = ev.delta;
        if (d.type === "text_delta" && b?.type === "text") {
          b.text += d.text;
        } else if (d.type === "thinking_delta" && b?.type === "thinking") {
          b.thinking += d.thinking;
        } else if (d.type === "signature_delta" && b?.type === "thinking") {
          b.signature += d.signature;
        } else if (d.type === "citations_delta" && b?.type === "text") {
          b.citations = [...(b.citations ?? []), d.citation];
        } else if (d.type === "input_json_delta") {
          json.set(ev.index, (json.get(ev.index) ?? "") + d.partial_json);
        }
        break;
      }
      case "message_delta":
        message ??= emptyMessage(fallback);
        message.stop_reason = ev.delta.stop_reason;
        message.stop_sequence = ev.delta.stop_sequence;
        message.usage = {
          ...message.usage,
          input_tokens: ev.usage.input_tokens,
          output_tokens: ev.usage.output_tokens,
          cache_creation_input_tokens: ev.usage.cache_creation_input_tokens,
          cache_read_input_tokens: ev.usage.cache_read_input_tokens,
          server_tool_use: ev.usage.server_tool_use,
          service_tier: null,
        };
        break;
      case "error":
        return { ok: false, error: ev };
      default:
        break;
    }
  }
  for (const [i, s] of json) {
    const b = blocks[i];
    if (b?.type === "tool_use" || b?.type === "server_tool_use") {
      try {
        b.input = JSON.parse(s) as { query: string };
      } catch {
        b.input = {};
      }
    }
  }
  const m = message ?? emptyMessage(fallback);
  m.content = blocks.filter((b): b is WireContentBlock => b !== undefined);
  return { ok: true, message: m };
}

function emptyMessage(f: { id: string; model: string }): WireMessage {
  return {
    id: f.id,
    type: "message",
    role: "assistant",
    model: f.model,
    container: null,
    content: [],
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: wireUsage(undefined, null),
  };
}
