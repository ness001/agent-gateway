import { newId } from "../../core/ids";
import type { Encoder, TurnSink } from "../../core/runTurn";
import type {
  CoreEvent,
  EndReason,
  GatewayErrorInfo,
  NormalizedUsage,
} from "../../core/types";
import { type OpenAiErrorEnvelope, openAiErrorEnvelope } from "../errors";

export type ChatFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Usage with the full detail objects. */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: {
    reasoning_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      refusal: null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: ChatFinishReason;
    logprobs: null;
  }>;
  usage: ChatCompletionUsage;
}

export interface ChatChunkToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments: string };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: ChatChunkToolCallDelta[];
    };
    finish_reason: ChatFinishReason | null;
    logprobs: null;
  }>;
  usage?: ChatCompletionUsage | null;
}

export const DONE_FRAME = "data: [DONE]\n\n";

export function finishReasonOf(reason: EndReason): ChatFinishReason {
  switch (reason) {
    case "tool":
      return "tool_calls";
    case "length":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Projects normalized usage; absent counts are reported as 0, never invented hits. */
export function chatUsage(u: NormalizedUsage | undefined): ChatCompletionUsage {
  const input = u?.input ?? 0;
  const output = u?.output ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: {
      cached_tokens: u?.cacheRead ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: u?.reasoning ?? 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

export const sseData = (value: unknown): string =>
  `data: ${JSON.stringify(value)}\n\n`;

export interface ChatEncoderOptions {
  model: string;
  stream: boolean;
  includeUsage: boolean;
  requestId: string;
  id?: string;
  created?: number;
}

/**
 * One encoder for both modes. Streaming writes SSE frames as events arrive;
 * JSON mode aggregates and writes a single serialized body on `finish`.
 * After an `error` event no success terminal is written: streaming writes one
 * error chunk (no `[DONE]`), JSON mode exposes `error` for the handler.
 */
export class ChatEncoder implements Encoder<string> {
  readonly id: string;
  readonly created: number;
  private text = "";
  private readonly calls: ChatToolCall[] = [];
  private roleSent = false;
  private end: { reason: EndReason; usage?: NormalizedUsage } | undefined;
  private failure: GatewayErrorInfo | undefined;
  private finished = false;

  constructor(private readonly o: ChatEncoderOptions) {
    this.id = o.id ?? newId("chatCompletion");
    this.created = o.created ?? Math.floor(Date.now() / 1000);
  }

  get error(): GatewayErrorInfo | undefined {
    return this.failure;
  }

  onEvent(ev: CoreEvent, sink: TurnSink<string>): void {
    if (this.failure || this.finished) {
      return;
    }
    switch (ev.e) {
      case "text":
        if (ev.delta === "") {
          return;
        }
        this.text += ev.delta;
        if (this.o.stream) {
          this.ensureRole(sink);
          sink.write(this.chunk({ content: ev.delta }, null));
        }
        return;
      case "toolCall": {
        const call: ChatToolCall = {
          id: ev.id,
          type: "function",
          function: { name: ev.name, arguments: JSON.stringify(ev.input) },
        };
        const index = this.calls.length;
        this.calls.push(call);
        if (this.o.stream) {
          this.ensureRole(sink);
          sink.write(
            this.chunk(
              {
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.function.name, arguments: "" },
                  },
                ],
              },
              null,
            ),
          );
          sink.write(
            this.chunk(
              {
                tool_calls: [
                  { index, function: { arguments: call.function.arguments } },
                ],
              },
              null,
            ),
          );
        }
        return;
      }
      case "end":
        this.end = ev.usage
          ? { reason: ev.reason, usage: ev.usage }
          : { reason: ev.reason };
        return;
      case "error":
        this.failure = ev.err;
        if (this.o.stream) {
          sink.write(sseData(openAiErrorEnvelope(ev.err, this.o.requestId)));
        }
        return;
      default:
        // thinking and hosted events have no Chat Completions representation.
        return;
    }
  }

  finish(sink: TurnSink<string>): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.failure) {
      return;
    }
    const reason = this.finishReason();
    if (!this.o.stream) {
      sink.write(JSON.stringify(this.completion()));
      return;
    }
    this.ensureRole(sink);
    sink.write(this.chunk({}, reason));
    if (this.o.includeUsage) {
      const usageChunk: ChatCompletionChunk = {
        ...this.base(),
        choices: [],
        usage: chatUsage(this.end?.usage),
      };
      sink.write(sseData(usageChunk));
    }
    sink.write(DONE_FRAME);
  }

  completion(): ChatCompletion {
    const message: ChatCompletion["choices"][0]["message"] = {
      role: "assistant",
      content: this.text,
      refusal: null,
    };
    if (this.calls.length > 0) {
      message.tool_calls = this.calls;
    }
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.o.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finishReason(),
          logprobs: null,
        },
      ],
      usage: chatUsage(this.end?.usage),
    };
  }

  private finishReason(): ChatFinishReason {
    if (this.calls.length > 0) {
      return "tool_calls";
    }
    return finishReasonOf(this.end?.reason ?? "stop");
  }

  private base(): Omit<ChatCompletionChunk, "choices"> {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.o.model,
    };
  }

  private chunk(
    delta: ChatCompletionChunk["choices"][0]["delta"],
    finish: ChatFinishReason | null,
  ): string {
    const c: ChatCompletionChunk = {
      ...this.base(),
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    };
    if (this.o.includeUsage) {
      c.usage = null;
    }
    return sseData(c);
  }

  private ensureRole(sink: TurnSink<string>): void {
    if (this.roleSent) {
      return;
    }
    this.roleSent = true;
    sink.write(this.chunk({ role: "assistant", content: "" }, null));
  }
}

export type { OpenAiErrorEnvelope };
