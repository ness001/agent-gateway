import { GatewayError } from "../protocol/core/errors";
import { randomToken } from "../protocol/core/ids";
import { asThinking } from "../protocol/core/lmStream";
import type { GatewayErrorKind } from "../protocol/core/types";
import { USAGE_MIME } from "../protocol/core/usage";
import { RemoteUnavailableError, forwardToRemote } from "./forward";
import { currentRequestContext } from "./requestContext";
import type { ModelInfo, RemoteUpstreamConfig } from "./types";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `vscode.LanguageModelChatMessageRole.Assistant`. */
const ASSISTANT_ROLE = 2;
/** `vscode.LanguageModelChatToolMode.Required`. */
const TOOL_MODE_REQUIRED = 2;
/** Input budget assumed when the remote list advertises none. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const CHAT_PATH = "/v1/chat/completions";
export interface ChatCompletionsModelOptions {
  /** Advertised gateway ID, e.g. `m365--quick`. */
  id: string;
  remote: RemoteUpstreamConfig;
  /** Model ID on the remote server. */
  upstreamModelId: string;
  info: Pick<ModelInfo, "displayName" | "contextWindow">;
  getApiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * A remote model that serves only OpenAI Chat Completions, presented as a
 * `vscode.LanguageModelChat`-like object so the protocol core can translate
 * every other inference API to it, exactly as it does for Copilot models.
 */
export function createChatCompletionsModel(o: ChatCompletionsModelOptions) {
  return {
    id: o.id,
    vendor: "agent-gateway-remote",
    name: o.info.displayName,
    family: o.upstreamModelId,
    maxInputTokens: o.info.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    sendRequest: (messages: unknown[], options?: unknown, token?: unknown) =>
      sendChatRequest(o, messages, options, token),
    countTokens: (value: unknown) =>
      Promise.resolve(Math.ceil(countChars(value) / 4)),
  };
}

// ---- Request: LM messages -> Chat Completions ----

const textOf = (p: Rec): string | undefined =>
  typeof p.value === "string" ? p.value : undefined;

const isToolCall = (p: Rec): boolean => "callId" in p && "input" in p;

const isToolResult = (p: Rec): boolean => "callId" in p && "content" in p;

function imageUrl(p: Rec): string | undefined {
  if (
    typeof p.mimeType === "string" &&
    p.mimeType.startsWith("image/") &&
    p.data instanceof Uint8Array
  ) {
    return `data:${p.mimeType};base64,${Buffer.from(p.data).toString("base64")}`;
  }
  return undefined;
}

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function appendContent(content: ContentItem[], part: Rec): void {
  const url = imageUrl(part);
  if (url) {
    content.push({ type: "image_url", image_url: { url } });
  } else if (typeof part.value === "string" && !asThinking(part)) {
    content.push({ type: "text", text: part.value });
  }
}

/** `vscode.LanguageModelChatMessage[]` -> Chat Completions messages. */
export function toChatMessages(messages: unknown[]): Rec[] {
  const out: Rec[] = [];
  for (const m of messages) {
    if (!isRec(m) || !Array.isArray(m.content)) {
      continue;
    }
    const parts = m.content.filter(isRec);
    if (m.role === ASSISTANT_ROLE) {
      const content = parts
        .filter((p) => !asThinking(p))
        .map(textOf)
        .join("");
      const calls = parts.filter(isToolCall).map((p) => ({
        id: p.callId,
        type: "function",
        function: { name: p.name, arguments: JSON.stringify(p.input) },
      }));
      if (content || calls.length) {
        const message: Rec = { role: "assistant", content: content || null };
        if (calls.length) {
          message.tool_calls = calls;
        }
        out.push(message);
      }
      continue;
    }
    // Keep tool results adjacent to their calls; attach result images afterward.
    const content: ContentItem[] = [];
    for (const p of parts) {
      if (!isToolResult(p)) {
        appendContent(content, p);
        continue;
      }
      const result: ContentItem[] = [];
      for (const part of (p.content as unknown[]).filter(isRec)) {
        appendContent(result, part);
      }
      const text = result.map((part) => {
        if (part.type === "text") {
          return part.text;
        }
        content.push(part);
        return "[image attached below]";
      });
      out.push({
        role: "tool",
        tool_call_id: p.callId,
        content: text.join(""),
      });
    }
    if (content.length) {
      out.push({
        role: "user",
        content: content.every((p) => p.type === "text")
          ? content.map((p) => p.text).join("")
          : content,
      });
    }
  }
  return out;
}

/** LM request options -> Chat Completions request body. */
export function toChatBody(
  model: string,
  messages: unknown[],
  options: unknown,
): Rec {
  const opts = isRec(options) ? options : {};
  const mo = isRec(opts.modelOptions) ? opts.modelOptions : {};
  const body: Rec = {
    model,
    messages: toChatMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof mo.max_tokens === "number") {
    body.max_tokens = mo.max_tokens;
  }
  if (typeof mo.reasoningEffort === "string") {
    body.reasoning_effort = mo.reasoningEffort;
  }
  const tools = Array.isArray(opts.tools) ? opts.tools.filter(isRec) : [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => {
      const fn: Rec = {
        name: t.name,
        parameters: isRec(t.inputSchema)
          ? t.inputSchema
          : { type: "object", properties: {} },
      };
      if (typeof t.description === "string" && t.description) {
        fn.description = t.description;
      }
      return { type: "function", function: fn };
    });
    if (opts.toolMode === TOOL_MODE_REQUIRED) {
      body.tool_choice = "required";
    }
  }
  return body;
}

function countChars(value: unknown, depth = 0): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value instanceof Uint8Array) {
    return 4_000; // An image costs roughly a thousand tokens.
  }
  if (depth > 8 || typeof value !== "object" || value === null) {
    return 0;
  }
  return Object.values(value).reduce<number>(
    (n, v) => n + countChars(v, depth + 1),
    0,
  );
}

// ---- Transport ----

async function sendChatRequest(
  o: ChatCompletionsModelOptions,
  messages: unknown[],
  options: unknown,
  token: unknown,
): Promise<{ stream: AsyncIterable<unknown> }> {
  const controller = new AbortController();
  const t = token as
    | {
        isCancellationRequested: boolean;
        onCancellationRequested(cb: () => void): { dispose(): void };
      }
    | undefined;
  if (t?.isCancellationRequested) {
    controller.abort();
  }
  const sub = t?.onCancellationRequested(() => controller.abort());
  const dispose = () => sub?.dispose();
  try {
    const response = await forwardToRemote({
      remote: o.remote,
      apiKey: await o.getApiKey(),
      method: "POST",
      path: CHAT_PATH,
      search: "",
      headers: new Headers({ accept: "text/event-stream, application/json" }),
      body: toChatBody(o.upstreamModelId, messages, options),
      upstreamModelId: o.upstreamModelId,
      signal: controller.signal,
      requestId: currentRequestContext()?.requestId,
      fetchImpl: o.fetchImpl,
    });
    if (!response.ok) {
      throw await httpError(response);
    }
    return { stream: readResponse(response, dispose) };
  } catch (error) {
    dispose();
    if (error instanceof RemoteUnavailableError) {
      throw new GatewayError(
        error.status === 504 ? "timeout" : "upstream_error",
        error.message,
      );
    }
    throw error;
  }
}

async function* readResponse(
  response: Response,
  dispose: () => void,
): AsyncGenerator<unknown> {
  const reader = new ChunkReader();
  try {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      // Servers may ignore `stream` and answer with one completion object.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw upstream("Remote response is not JSON.");
      }
      if (isRec(body)) {
        yield* reader.read(body);
      }
    } else if (response.body) {
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") {
          break;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // keep-alive comments or malformed lines
        }
        if (isRec(chunk)) {
          yield* reader.read(chunk);
        }
      }
    }
    yield* reader.finish();
  } finally {
    dispose();
    await response.body?.cancel().catch(() => undefined);
  }
}

async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const stream = (body as ReadableStream<BufferSource>).pipeThrough(
    new TextDecoderStream(),
  );
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<string>) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("data:")) {
        yield line.slice(5).trim();
      }
    }
  }
  if (pending.startsWith("data:")) {
    yield pending.slice(5).trim();
  }
}

// ---- Response: Chat Completions chunks -> LM stream parts ----

/** Emits parts the protocol core reads by shape (see `core/lmStream.ts`). */
class ChunkReader {
  private readonly calls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  *read(chunk: Rec): Generator<unknown> {
    if (chunk.error !== undefined && chunk.error !== null) {
      throw upstream("Remote stream error.");
    }
    if (chunk.usage) {
      yield { mimeType: USAGE_MIME, data: chunk.usage };
    }
    const choice = (chunk.choices as Rec[] | undefined)?.[0];
    const delta = choice?.delta ?? choice?.message;
    if (!isRec(delta)) {
      return;
    }
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : undefined;
    if (reasoning) {
      yield { value: reasoning, metadata: {} };
    }
    if (typeof delta.content === "string" && delta.content) {
      yield { value: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((c: unknown, position: number) => {
        if (!isRec(c)) {
          return;
        }
        const index = typeof c.index === "number" ? c.index : position;
        const fn = isRec(c.function) ? c.function : {};
        let call = this.calls.get(index);
        if (!call) {
          call = { id: "", name: "", args: "" };
          this.calls.set(index, call);
        }
        if (typeof c.id === "string") {
          call.id = c.id;
        }
        if (typeof fn.name === "string" && !call.name) {
          call.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          call.args += fn.arguments;
        } else if (isRec(fn.arguments)) {
          call.args = JSON.stringify(fn.arguments);
        }
      });
    }
  }

  /** Tool calls are complete only when the stream ends. */
  *finish(): Generator<unknown> {
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b);
    for (const [, call] of ordered) {
      if (!call.name) {
        continue;
      }
      let input: unknown = {};
      if (call.args.trim()) {
        try {
          input = JSON.parse(call.args);
        } catch {
          throw upstream("Invalid remote tool arguments.");
        }
      }
      yield {
        callId: call.id || `call_${randomToken(24)}`,
        name: call.name,
        input: isRec(input) ? input : {},
      };
    }
  }
}

// ---- Errors ----

function upstream(message: string): GatewayError {
  return new GatewayError("upstream_error", message);
}

const HTTP_ERRORS: Partial<Record<number, GatewayErrorKind>> = {
  401: "permission",
  403: "permission",
  404: "not_found",
  408: "timeout",
  429: "rate_limit",
  503: "overloaded",
  504: "timeout",
  529: "overloaded",
};

async function httpError(response: Response): Promise<GatewayError> {
  const { status } = response;
  const kind =
    HTTP_ERRORS[status] ??
    (status >= 500 ? "upstream_error" : "upstream_rejected");
  let providerCode = String(status);
  // Only surface a recognized code, not provider error text.
  if (status === 400 || status === 413) {
    const body = await response.json().catch(() => undefined);
    if (body?.error?.code === "context_length_exceeded") {
      providerCode = "context_length_exceeded";
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  const after =
    status === 429 ? Number(response.headers.get("retry-after")) : 0;
  const message =
    kind === "permission"
      ? "The remote rejected the API key."
      : providerCode === "context_length_exceeded"
        ? "Remote context window exceeded."
        : `Remote request failed (HTTP ${status}).`;
  return new GatewayError(kind, message, {
    providerCode,
    retryAfter:
      after > 0 && Number.isFinite(after) ? Math.ceil(after) : undefined,
  });
}
