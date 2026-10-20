import { googleErrorBody } from "../core/errors";
import type { Encoder, TurnSink } from "../core/runTurn";
import type {
  CoreEvent,
  EndReason,
  GatewayErrorInfo,
  NormalizedUsage,
  Source,
} from "../core/types";
import { type GeminiUsage, reachedLimit, toGeminiUsage } from "../core/usage";
import {
  type GroundingMetadata,
  groundingMetadata,
  urlContextMetadata,
} from "../hosted/output/gemini";
import type { UrlMetadata } from "../hosted/urlContext";

/**
 * Output mode:
 * - `json`: non-streaming `generateContent`; `finish` writes one JSON body.
 * - `sse`: `streamGenerateContent?alt=sse`; `data: <json>\n\n` per chunk.
 * - `array`: `streamGenerateContent` without `alt=sse`; one JSON array
 *   written incrementally.
 */
export type GeminiMode = "json" | "sse" | "array";

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "OTHER";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id: string; name: string; args: object };
}

export interface GeminiCandidate {
  content?: { parts: GeminiPart[]; role: "model" };
  finishReason?: GeminiFinishReason;
  index: 0;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: { urlMetadata: UrlMetadata[] };
}

export interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
  responseId?: string;
}

export interface GeminiEncoderOptions {
  mode: GeminiMode;
  /** Echoed as `modelVersion` (the model name the client asked for). */
  modelVersion: string;
  /** `generationConfig.thinkingConfig.includeThoughts`. */
  includeThoughts?: boolean;
  /** Client `maxOutputTokens`, used to prove MAX_TOKENS. */
  maxOutputTokens?: number;
  /** Optional `responseId`; omitted when undefined. */
  responseId?: string;
  /** Request id put in the error chunk / envelope. */
  requestId: string;
}

/** Response content type for a mode. */
export function geminiContentType(mode: GeminiMode): string {
  return mode === "sse" ? "text/event-stream" : "application/json";
}

/** `alt=sse` selects SSE; anything else streams a JSON array. */
export function streamModeFromUrl(url: string | URL): "sse" | "array" {
  const u = typeof url === "string" ? new URL(url, "http://local/") : url;
  return u.searchParams.get("alt") === "sse" ? "sse" : "array";
}

/**
 * MAX_TOKENS only when usage proves the limit
 * was reached; a refusal maps to SAFETY; everything else that ends normally
 * (stop, tool calls, stop sequence) is STOP.
 */
export function geminiFinishReason(
  reason: EndReason | undefined,
  usage: NormalizedUsage | undefined,
  limit: number | undefined,
): GeminiFinishReason {
  switch (reason) {
    case "length":
      return reachedLimit(usage, limit) ? "MAX_TOKENS" : "STOP";
    case "refusal":
      return "SAFETY";
    case "stop":
    case "tool":
    case "stopSequence":
    case undefined:
      return "STOP";
    default:
      return "OTHER";
  }
}

/**
 * One encoder for all three modes. Hosted search events are collected and
 * reported as `groundingMetadata` on the final chunk; urlContext
 * results set via {@link setUrlContext} become `urlContextMetadata`.
 * Neither is ever logged.
 */
export class GeminiEncoder implements Encoder<string> {
  private readonly parts: GeminiPart[] = [];
  private endReason: EndReason | undefined;
  private usage: NormalizedUsage | undefined;
  private failure: GatewayErrorInfo | undefined;
  private opened = false;
  private finished = false;
  private answer = "";
  private readonly queries: string[] = [];
  private readonly sources: Source[] = [];
  private searched = false;
  private urlMeta: UrlMetadata[] | undefined;

  constructor(private readonly o: GeminiEncoderOptions) {}

  /** Error seen in `json` mode; the caller turns it into an error response. */
  get error(): GatewayErrorInfo | undefined {
    return this.failure;
  }

  /** urlContext retrieval statuses, reported at finish. */
  setUrlContext(meta: readonly UrlMetadata[]): void {
    this.urlMeta = [...meta];
  }

  onEvent(ev: CoreEvent, sink: TurnSink<string>): void {
    if (this.finished || this.failure) {
      return;
    }
    switch (ev.e) {
      case "text":
        if (ev.delta) {
          if (!ev.sources) {
            // The appended Sources list gets no grounding supports.
            this.answer += ev.delta;
          }
          this.part({ text: ev.delta }, sink);
        }
        return;
      case "thinking": {
        if (!this.o.includeThoughts || (!ev.delta && !ev.signature)) {
          return;
        }
        const p: GeminiPart = { text: ev.delta, thought: true };
        if (ev.signature) {
          p.thoughtSignature = ev.signature;
        }
        this.part(p, sink);
        return;
      }
      case "toolCall":
        this.part(
          { functionCall: { id: ev.id, name: ev.name, args: ev.input } },
          sink,
        );
        return;
      case "end":
        this.endReason = ev.reason;
        this.usage = ev.usage;
        return;
      case "error":
        this.failure = ev.err;
        if (this.o.mode !== "json") {
          this.chunk(googleErrorBody(ev.err, this.o.requestId), sink);
        }
        return;
      case "hostedCall":
        this.searched = true;
        if (ev.query) {
          this.queries.push(ev.query);
        }
        return;
      case "hostedResult":
        this.sources.push(...ev.sources);
        return;
    }
  }

  finish(sink: TurnSink<string>): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.failure) {
      if (this.o.mode === "array") {
        sink.write(this.opened ? "]" : "[]");
      }
      return;
    }
    const tail: GeminiResponse = {
      candidates: [
        {
          finishReason: geminiFinishReason(
            this.endReason,
            this.usage,
            this.o.maxOutputTokens,
          ),
          index: 0,
        },
      ],
      usageMetadata: toGeminiUsage(this.usage),
      modelVersion: this.o.modelVersion,
    };
    if (this.searched) {
      tail.candidates[0].groundingMetadata = groundingMetadata(
        this.queries,
        this.sources,
        this.answer,
      );
    }
    if (this.urlMeta) {
      tail.candidates[0].urlContextMetadata = urlContextMetadata(this.urlMeta);
    }
    if (this.o.responseId !== undefined) {
      tail.responseId = this.o.responseId;
    }
    if (this.o.mode === "json") {
      tail.candidates[0] = {
        content: { parts: this.parts, role: "model" },
        ...tail.candidates[0],
      };
      sink.write(JSON.stringify(tail));
      return;
    }
    this.chunk(tail, sink);
    if (this.o.mode === "array") {
      sink.write("]");
    }
  }

  private part(p: GeminiPart, sink: TurnSink<string>): void {
    if (this.o.mode === "json") {
      this.merge(p);
      return;
    }
    const body: GeminiResponse = {
      candidates: [{ content: { parts: [p], role: "model" }, index: 0 }],
    };
    if (this.o.responseId !== undefined) {
      body.responseId = this.o.responseId;
    }
    this.chunk(body, sink);
  }

  /** JSON mode: consecutive text (or thought) deltas become one part. */
  private merge(p: GeminiPart): void {
    const last = this.parts[this.parts.length - 1];
    if (
      last &&
      p.text !== undefined &&
      last.text !== undefined &&
      !p.functionCall &&
      !!last.thought === !!p.thought &&
      !last.thoughtSignature
    ) {
      last.text += p.text;
      if (p.thoughtSignature) {
        last.thoughtSignature = p.thoughtSignature;
      }
      return;
    }
    this.parts.push({ ...p });
  }

  private chunk(body: object, sink: TurnSink<string>): void {
    const json = JSON.stringify(body);
    if (this.o.mode === "sse") {
      sink.write(`data: ${json}\n\n`);
      return;
    }
    sink.write((this.opened ? "," : "[") + json);
    this.opened = true;
  }
}
