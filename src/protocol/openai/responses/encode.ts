import { newId } from "../../core/ids";
import type { Encoder, TurnSink } from "../../core/runTurn";
import type {
  CoreEvent,
  CoreRequest,
  GatewayErrorInfo,
  NormalizedUsage,
} from "../../core/types";
import type { CitationRegistry } from "../../hosted/citations";
import {
  type WebSearchCallItem,
  urlCitations,
  webSearchCallEvents,
  webSearchCallItem,
} from "../../hosted/output/responses";
import { type ResponsesErrorObject, toResponsesError } from "./errors";

/** One streaming event: SSE `event:` name plus its JSON payload. */
export interface ResponsesFrame {
  event: string;
  data: Record<string, unknown>;
}

export interface ResponsesWireUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface MessageItem {
  type: "message";
  id: string;
  role: "assistant";
  content: OutputTextPart[];
  status: "in_progress" | "completed" | "incomplete";
}

export interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  /** Set when the function belongs to a `namespace` tool. */
  namespace?: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface CustomToolCallItem {
  type: "custom_tool_call";
  id: string;
  call_id: string;
  name: string;
  namespace?: string;
  input: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface ToolSearchCallItem {
  type: "tool_search_call";
  id: string;
  call_id: string;
  execution: "client";
  arguments: unknown;
  status: "in_progress" | "completed" | "incomplete";
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export type OutputItem =
  | MessageItem
  | FunctionCallItem
  | CustomToolCallItem
  | ToolSearchCallItem
  | ReasoningItem
  | WebSearchCallItem;

export type ResponseStatus =
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed";

export interface ResponseObject extends Record<string, unknown> {
  id: string;
  object: "response";
  status: ResponseStatus;
  created_at: number;
  completed_at: number | null;
  model: string;
  output: OutputItem[];
  error: ResponsesErrorObject | null;
  incomplete_details: { reason: string } | null;
  usage: ResponsesWireUsage | null;
}

/** Usage with nested details always present. */
export function toWireUsage(
  u: NormalizedUsage | undefined,
): ResponsesWireUsage {
  const input = u?.input ?? 0;
  const output = u?.output ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: u?.cacheRead ?? 0,
      cache_write_tokens: u?.cacheWrite ?? 0,
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u?.reasoning ?? 0 },
    total_tokens: input + output,
  };
}

/** SSE framing: `event: <type>\ndata: <json>\n\n`. */
export function formatFrame(f: ResponsesFrame): string {
  return `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`;
}

export interface ResponsesEncoderOptions {
  /** Include `encrypted_content` on reasoning items. */
  includeEncryptedReasoning?: boolean;
  /** LM tool name -> namespace and wire name (`namespace` tools). */
  namespaced?: ReadonlyMap<string, { namespace: string; name: string }>;
  /** LM tool names of `custom` (freeform) tools; calls become custom_tool_call. */
  custom?: ReadonlySet<string>;
  /** Calls to the `tool_search` function become tool_search_call items. */
  toolSearch?: boolean;
  /** Emit reasoning summary text; false when the client set no `reasoning.summary`. */
  summary?: boolean;
  /** Hosted search citation registry (stable [n] indices). */
  citations?: CitationRegistry;
  now?: () => number;
  ids?: {
    response(): string;
    message(): string;
    functionCall(): string;
    customToolCall(): string;
    toolSearchCall(): string;
    reasoning(): string;
  };
}

const defaultIds = {
  response: () => newId("response"),
  message: () => newId("responseMessage"),
  functionCall: () => newId("functionCallItem"),
  customToolCall: () => newId("customToolCall"),
  toolSearchCall: () => newId("toolSearchCall"),
  reasoning: () => newId("reasoning"),
};

type Open =
  | {
      kind: "message";
      index: number;
      item: MessageItem;
      text: string;
      /** Length of the text scanned for citations (excludes Sources). */
      cited?: number;
    }
  | { kind: "reasoning"; index: number; item: ReasoningItem; text: string };

/**
 * Responses encoder. Emits the streaming lifecycle with
 * a `sequence_number` starting at 0, and keeps the final Response object for
 * the non-streaming path (`result()`).
 */
export class ResponsesEncoder implements Encoder<ResponsesFrame> {
  private seq = 0;
  private started = false;
  private finished = false;
  private open: Open | undefined;
  private readonly output: OutputItem[] = [];
  private readonly response: ResponseObject;
  private readonly now: () => number;
  private readonly ids: NonNullable<ResponsesEncoderOptions["ids"]>;
  private failure: GatewayErrorInfo | undefined;
  /** Pending hosted call queries by internal call id. */
  private readonly hostedQueries = new Map<string, string>();

  constructor(
    private readonly req: Pick<CoreRequest, "echoModel" | "echo">,
    private readonly opts: ResponsesEncoderOptions = {},
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.ids = opts.ids ?? defaultIds;
    this.response = {
      id: this.ids.response(),
      object: "response",
      status: "in_progress",
      created_at: this.now(),
      completed_at: null,
      background: false,
      model: req.echoModel,
      output: [],
      error: null,
      incomplete_details: null,
      metadata: {},
      parallel_tool_calls: true,
      reasoning: { effort: "none", summary: null },
      tool_choice: "auto",
      tools: [],
      ...req.echo,
      usage: null,
    };
  }

  /** Final Response object (valid after `finish`). */
  result(): ResponseObject {
    return this.snapshot();
  }

  /** Error that ended the turn, if any. */
  error(): GatewayErrorInfo | undefined {
    return this.failure;
  }

  private snapshot(): ResponseObject {
    return {
      ...this.response,
      output: this.output.map((o) => structuredClone(o)),
    };
  }

  private emit(
    sink: TurnSink<ResponsesFrame>,
    event: string,
    data: Record<string, unknown>,
  ): void {
    sink.write({
      event,
      data: { type: event, ...data, sequence_number: this.seq++ },
    });
  }

  private start(sink: TurnSink<ResponsesFrame>): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emit(sink, "response.created", { response: this.snapshot() });
    this.emit(sink, "response.in_progress", { response: this.snapshot() });
  }

  private closeOpen(
    sink: TurnSink<ResponsesFrame>,
    status: "completed" | "incomplete",
  ): void {
    const o = this.open;
    if (!o) {
      return;
    }
    this.open = undefined;
    if (o.kind === "message") {
      const reg = this.opts.citations;
      const part: OutputTextPart = {
        type: "output_text",
        text: o.text,
        annotations: reg?.size
          ? urlCitations(o.text.slice(0, o.cited ?? o.text.length), reg.all())
          : [],
      };
      const base = {
        item_id: o.item.id,
        output_index: o.index,
        content_index: 0,
      };
      this.emit(sink, "response.output_text.done", { ...base, text: o.text });
      this.emit(sink, "response.content_part.done", { ...base, part });
      o.item.content = [part];
      o.item.status = status;
    } else if (this.opts.summary !== false) {
      const base = {
        item_id: o.item.id,
        output_index: o.index,
        summary_index: 0,
      };
      this.emit(sink, "response.reasoning_summary_text.done", {
        ...base,
        text: o.text,
      });
      this.emit(sink, "response.reasoning_summary_part.done", {
        ...base,
        part: { type: "summary_text", text: o.text },
      });
      o.item.summary = [{ type: "summary_text", text: o.text }];
    }
    this.emit(sink, "response.output_item.done", {
      output_index: o.index,
      item: structuredClone(o.item),
    });
  }

  private onText(
    delta: string,
    sink: TurnSink<ResponsesFrame>,
    sources = false,
  ): void {
    if (this.open?.kind !== "message") {
      this.closeOpen(sink, "completed");
      const item: MessageItem = {
        type: "message",
        id: this.ids.message(),
        role: "assistant",
        content: [],
        status: "in_progress",
      };
      const index = this.output.length;
      this.output.push(item);
      this.open = { kind: "message", index, item, text: "" };
      this.emit(sink, "response.output_item.added", {
        output_index: index,
        item: structuredClone(item),
      });
      this.emit(sink, "response.content_part.added", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    const o = this.open as Extract<Open, { kind: "message" }>;
    if (sources && o.cited === undefined) {
      o.cited = o.text.length;
    }
    o.text += delta;
    o.item.content = [{ type: "output_text", text: o.text, annotations: [] }];
    this.emit(sink, "response.output_text.delta", {
      item_id: o.item.id,
      output_index: o.index,
      content_index: 0,
      delta,
    });
  }

  private onThinking(
    delta: string,
    signature: string | undefined,
    sink: TurnSink<ResponsesFrame>,
  ): void {
    if (this.open?.kind !== "reasoning") {
      this.closeOpen(sink, "completed");
      const item: ReasoningItem = {
        type: "reasoning",
        id: this.ids.reasoning(),
        summary: [],
      };
      const index = this.output.length;
      this.output.push(item);
      this.open = { kind: "reasoning", index, item, text: "" };
      this.emit(sink, "response.output_item.added", {
        output_index: index,
        item: structuredClone(item),
      });
      if (this.opts.summary !== false)
        this.emit(sink, "response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
    }
    const o = this.open as Extract<Open, { kind: "reasoning" }>;
    if (signature !== undefined && this.opts.includeEncryptedReasoning) {
      o.item.encrypted_content = signature;
    }
    if (delta && this.opts.summary !== false) {
      o.text += delta;
      o.item.summary = [{ type: "summary_text", text: o.text }];
      this.emit(sink, "response.reasoning_summary_text.delta", {
        item_id: o.item.id,
        output_index: o.index,
        summary_index: 0,
        delta,
      });
    }
  }

  private onToolCall(
    ev: Extract<CoreEvent, { e: "toolCall" }>,
    sink: TurnSink<ResponsesFrame>,
  ): void {
    this.closeOpen(sink, "completed");
    if (this.opts.toolSearch && ev.name === "tool_search") {
      // Client-executed search: the item is complete when emitted.
      const item: ToolSearchCallItem = {
        type: "tool_search_call",
        id: this.ids.toolSearchCall(),
        call_id: ev.id,
        execution: "client",
        arguments: ev.input ?? {},
        status: "completed",
      };
      const index = this.output.length;
      this.output.push(item);
      this.emit(sink, "response.output_item.added", {
        output_index: index,
        item: structuredClone(item),
      });
      this.emit(sink, "response.output_item.done", {
        output_index: index,
        item: structuredClone(item),
      });
      return;
    }
    if (this.opts.custom?.has(ev.name)) {
      this.onCustomToolCall(ev, sink);
      return;
    }
    const args = JSON.stringify(ev.input ?? {});
    const item: FunctionCallItem = {
      type: "function_call",
      id: this.ids.functionCall(),
      call_id: ev.id,
      ...(this.opts.namespaced?.get(ev.name) ?? { name: ev.name }),
      arguments: "",
      status: "in_progress",
    };
    const index = this.output.length;
    this.output.push(item);
    this.emit(sink, "response.output_item.added", {
      output_index: index,
      item: structuredClone(item),
    });
    this.emit(sink, "response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: index,
      delta: args,
    });
    this.emit(sink, "response.function_call_arguments.done", {
      item_id: item.id,
      output_index: index,
      name: item.name,
      arguments: args,
    });
    item.arguments = args;
    item.status = "completed";
    this.emit(sink, "response.output_item.done", {
      output_index: index,
      item: structuredClone(item),
    });
  }

  /** Freeform tool call: the text from the single `input` parameter. */
  private onCustomToolCall(
    ev: Extract<CoreEvent, { e: "toolCall" }>,
    sink: TurnSink<ResponsesFrame>,
  ): void {
    const raw = (ev.input as Record<string, unknown> | undefined)?.input;
    const input =
      typeof raw === "string" ? raw : JSON.stringify(ev.input ?? {});
    const item: CustomToolCallItem = {
      type: "custom_tool_call",
      id: this.ids.customToolCall(),
      call_id: ev.id,
      ...(this.opts.namespaced?.get(ev.name) ?? { name: ev.name }),
      input: "",
      status: "in_progress",
    };
    const index = this.output.length;
    this.output.push(item);
    this.emit(sink, "response.output_item.added", {
      output_index: index,
      item: structuredClone(item),
    });
    this.emit(sink, "response.custom_tool_call_input.delta", {
      item_id: item.id,
      output_index: index,
      delta: input,
    });
    this.emit(sink, "response.custom_tool_call_input.done", {
      item_id: item.id,
      output_index: index,
      input,
    });
    item.input = input;
    item.status = "completed";
    this.emit(sink, "response.output_item.done", {
      output_index: index,
      item: structuredClone(item),
    });
  }

  /** One completed web_search_call item (ws_ id). */
  private onHostedResult(
    ev: Extract<CoreEvent, { e: "hostedResult" }>,
    sink: TurnSink<ResponsesFrame>,
  ): void {
    this.closeOpen(sink, "completed");
    const query = this.hostedQueries.get(ev.callId) ?? "";
    this.hostedQueries.delete(ev.callId);
    const item = webSearchCallItem(
      newId("webSearchCall"),
      query,
      ev.sources,
      ev.error,
    );
    const index = this.output.length;
    this.output.push(item);
    for (const frame of webSearchCallEvents(item, index)) {
      const { type, ...data } = frame;
      this.emit(sink, String(type), data);
    }
  }

  onEvent(ev: CoreEvent, sink: TurnSink<ResponsesFrame>): void {
    if (this.finished) {
      return;
    }
    this.start(sink);
    switch (ev.e) {
      case "text":
        if (ev.delta) {
          this.onText(ev.delta, sink, ev.sources === true);
        }
        return;
      case "thinking":
        this.onThinking(ev.delta, ev.signature, sink);
        return;
      case "toolCall":
        this.onToolCall(ev, sink);
        return;
      case "hostedCall":
        this.hostedQueries.set(ev.id, ev.query ?? "");
        return;
      case "hostedResult":
        this.onHostedResult(ev, sink);
        return;
      case "end": {
        const length = ev.reason === "length";
        this.closeOpen(sink, length ? "incomplete" : "completed");
        this.response.usage = toWireUsage(ev.usage);
        if (length) {
          this.response.status = "incomplete";
          this.response.incomplete_details = { reason: "max_output_tokens" };
        } else {
          this.response.status = "completed";
          this.response.completed_at = this.now();
        }
        this.terminal(sink);
        return;
      }
      case "error":
        this.closeOpen(sink, "incomplete");
        this.failure = ev.err;
        this.response.status = "failed";
        this.response.error = toResponsesError(ev.err);
        this.terminal(sink);
        return;
    }
  }

  private terminal(sink: TurnSink<ResponsesFrame>): void {
    this.finished = true;
    const event =
      this.response.status === "failed"
        ? "response.failed"
        : this.response.status === "incomplete"
          ? "response.incomplete"
          : "response.completed";
    this.emit(sink, event, { response: this.snapshot() });
  }

  finish(sink: TurnSink<ResponsesFrame>): void {
    if (this.finished) {
      return;
    }
    // Stream ended without an `end` event: treat as a normal completion.
    this.onEvent({ e: "end", reason: "stop" }, sink);
  }
}
