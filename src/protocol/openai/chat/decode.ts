import { GatewayError } from "../../core/errors";
import {
  decodeImage,
  describedPart,
  imageLinkPart,
  omittedData,
} from "../../core/images";
import type {
  CoreLogger,
  CoreRequest,
  ImagePart,
  Part,
  TextPart,
  ToolDef,
  ToolMode,
  Turn,
} from "../../core/types";

/** Chat-specific flags carried in `CoreRequest.echo`. */
export interface ChatEcho {
  includeUsage: boolean;
}

export const NOT_OBJECT_MESSAGE = "Request body must be a JSON object.";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (message: string, param?: string): GatewayError =>
  new GatewayError("invalid_request", message, param ? { param } : {});

function expectString(v: unknown, param: string): string {
  if (typeof v !== "string") {
    throw bad(`'${param}' must be a string.`, param);
  }
  return v;
}

function optNumber(body: Rec, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw bad(`'${key}' must be a number.`, key);
  }
  return v;
}

function optInt(body: Rec, key: string): number | undefined {
  const v = optNumber(body, key);
  if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
    throw bad(`'${key}' must be a positive integer.`, key);
  }
  return v;
}

function optBool(body: Rec, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "boolean") {
    throw bad(`'${key}' must be a boolean.`, key);
  }
  return v;
}

/** Text-only content (system/developer/tool messages). */
function textOnly(content: unknown, param: string): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw bad(`'${param}' must be a string or an array of parts.`, param);
  }
  return content
    .map((p, i) => {
      const pp = `${param}[${i}]`;
      if (!isRec(p) || p.type !== "text") {
        throw bad(`'${pp}' must be a text part.`, pp);
      }
      return expectString(p.text, `${pp}.text`);
    })
    .join("\n");
}

function imageFrom(
  part: Rec,
  param: string,
  logger: CoreLogger | undefined,
): ImagePart | TextPart {
  const iu = part.image_url;
  const url = isRec(iu) ? iu.url : iu;
  if (typeof url !== "string") {
    throw bad(
      `'${param}.image_url.url' must be a string.`,
      `${param}.image_url.url`,
    );
  }
  if (!url.trim().startsWith("data:")) {
    // Downloaded by the handler; the text stays if that fails.
    const detail =
      isRec(iu) && typeof iu.detail === "string" ? iu.detail : undefined;
    return imageLinkPart(
      { type: "image_url", url, detail },
      url,
      "openai chat",
      logger,
    );
  }
  const img = decodeImage(url, { param: `${param}.image_url.url`, logger });
  return { type: "image", mime: img.mime, data: img.bytes };
}

/** User/assistant content: string or text/image_url/refusal parts. */
function richContent(
  content: unknown,
  param: string,
  allowImages: boolean,
  logger: CoreLogger | undefined,
): Array<TextPart | ImagePart> {
  if (content === undefined || content === null) {
    return [];
  }
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    throw bad(`'${param}' must be a string or an array of parts.`, param);
  }
  const out: Array<TextPart | ImagePart> = [];
  content.forEach((p, i) => {
    const pp = `${param}[${i}]`;
    if (!isRec(p) || typeof p.type !== "string") {
      throw bad(`'${pp}' must be an object with a 'type'.`, pp);
    }
    switch (p.type) {
      case "text":
        out.push({ type: "text", text: expectString(p.text, `${pp}.text`) });
        return;
      case "refusal":
        out.push({
          type: "text",
          text: expectString(p.refusal, `${pp}.refusal`),
        });
        return;
      case "image_url":
        if (!allowImages) {
          throw bad(
            `'${pp}': image parts are only allowed in user messages.`,
            pp,
          );
        }
        out.push(imageFrom(p, pp, logger));
        return;
      case "input_audio":
      case "file":
        out.push(describedPart(fileFields(p), "openai chat", logger));
        return;
      default:
        throw new GatewayError(
          "unsupported",
          `Content part type '${p.type}' is not supported.`,
          { param: `${pp}.type` },
        );
    }
  });
  return out;
}

/** Reference fields of an audio/file part, with inline data omitted. */
function fileFields(p: Rec): Rec {
  const inner = isRec(p.input_audio)
    ? p.input_audio
    : isRec(p.file)
      ? p.file
      : {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    type: p.type,
    file_id: str(inner.file_id),
    filename: str(inner.filename),
    format: str(inner.format),
    data:
      typeof inner.data === "string"
        ? omittedData(inner.data)
        : typeof inner.file_data === "string"
          ? omittedData(inner.file_data)
          : undefined,
  };
}

function parseArguments(raw: unknown): object {
  if (isRec(raw)) {
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  try {
    const v: unknown = JSON.parse(raw);
    return isRec(v) ? v : {};
  } catch {
    // Replayed history with truncated arguments: keep the call, drop the args.
    return {};
  }
}

function assistantToolCalls(calls: unknown, param: string): Part[] {
  if (calls === undefined || calls === null) {
    return [];
  }
  if (!Array.isArray(calls)) {
    throw bad(`'${param}' must be an array.`, param);
  }
  return calls.map((c, i) => {
    const pp = `${param}[${i}]`;
    if (!isRec(c) || !isRec(c.function)) {
      throw bad(`'${pp}.function' must be an object.`, `${pp}.function`);
    }
    return {
      type: "toolCall",
      id: expectString(c.id, `${pp}.id`),
      name: expectString(c.function.name, `${pp}.function.name`),
      input: parseArguments(c.function.arguments),
    };
  });
}

function pushTurn(turns: Turn[], role: Turn["role"], parts: Part[]): void {
  if (parts.length === 0) {
    return;
  }
  const last = turns[turns.length - 1];
  // Merge consecutive tool results (and user text after them) into one turn.
  if (
    last &&
    last.role === role &&
    role === "user" &&
    last.parts.some((p) => p.type === "toolResult")
  ) {
    last.parts.push(...parts);
    return;
  }
  turns.push({ role, parts });
}

function decodeMessages(
  raw: unknown,
  logger: CoreLogger | undefined,
): { system: string[]; turns: Turn[] } {
  if (!Array.isArray(raw)) {
    throw bad("'messages' must be an array.", "messages");
  }
  if (raw.length === 0) {
    throw bad("'messages' must contain at least one message.", "messages");
  }
  const system: string[] = [];
  const turns: Turn[] = [];
  raw.forEach((m, i) => {
    const p = `messages[${i}]`;
    if (!isRec(m)) {
      throw bad(`'${p}' must be an object.`, p);
    }
    switch (m.role) {
      case "system":
      case "developer": {
        const t = textOnly(m.content, `${p}.content`);
        if (t) {
          system.push(t);
        }
        return;
      }
      case "user":
        pushTurn(
          turns,
          "user",
          richContent(m.content, `${p}.content`, true, logger),
        );
        return;
      case "assistant":
        pushTurn(turns, "assistant", [
          ...richContent(m.content, `${p}.content`, false, logger),
          ...assistantToolCalls(m.tool_calls, `${p}.tool_calls`),
        ]);
        return;
      case "tool":
        pushTurn(turns, "user", [
          {
            type: "toolResult",
            callId: expectString(m.tool_call_id, `${p}.tool_call_id`),
            content: [
              { type: "text", text: textOnly(m.content, `${p}.content`) },
            ],
            isError: false,
          },
        ]);
        return;
      case "function":
        throw new GatewayError(
          "unsupported",
          "The legacy 'function' role is not supported; use 'tool'.",
          { param: `${p}.role` },
        );
      default:
        throw bad(
          `'${p}.role' must be one of system, developer, user, assistant, tool.`,
          `${p}.role`,
        );
    }
  });
  return { system, turns };
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

function decodeTools(raw: unknown): ToolDef[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw bad("'tools' must be an array.", "tools");
  }
  return raw.map((t, i) => {
    const p = `tools[${i}]`;
    if (!isRec(t) || t.type !== "function" || !isRec(t.function)) {
      throw new GatewayError(
        "unsupported",
        `'${p}': only tools of type 'function' are supported.`,
        { param: `${p}.type` },
      );
    }
    const f = t.function;
    const name = expectString(f.name, `${p}.function.name`);
    if (name === "") {
      throw bad(
        `'${p}.function.name' must not be empty.`,
        `${p}.function.name`,
      );
    }
    const def: ToolDef = {
      name,
      inputSchema: isRec(f.parameters) ? f.parameters : EMPTY_SCHEMA,
    };
    if (typeof f.description === "string") {
      def.description = f.description;
    }
    return def;
  });
}

function decodeToolChoice(raw: unknown): ToolMode {
  if (raw === undefined || raw === null || raw === "auto") {
    return { kind: "auto" };
  }
  if (raw === "none") {
    return { kind: "none" };
  }
  if (raw === "required") {
    return { kind: "required" };
  }
  if (isRec(raw) && raw.type === "function" && isRec(raw.function)) {
    const name = expectString(raw.function.name, "tool_choice.function.name");
    return { kind: "required", only: [name] };
  }
  throw bad(
    "'tool_choice' must be 'none', 'auto', 'required' or {type:'function', function:{name}}.",
    "tool_choice",
  );
}

function decodeStop(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
    return raw as string[];
  }
  throw bad("'stop' must be a string or an array of strings.", "stop");
}

/**
 * Chat Completions body -> CoreRequest. `model` is the requested name; the
 * handler resolves it. `user`, `metadata`, `store`, `seed`, `n` (1), penalties
 * and other unknown keys are ignored.
 */
export function decodeChatRequest(
  body: unknown,
  logger?: CoreLogger,
): CoreRequest {
  if (!isRec(body)) {
    throw bad(NOT_OBJECT_MESSAGE);
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw bad("You must provide a model parameter.", "model");
  }
  const n = optInt(body, "n");
  if (n !== undefined && n !== 1) {
    throw new GatewayError("unsupported", "Only n=1 is supported.", {
      param: "n",
    });
  }
  const { system, turns } = decodeMessages(body.messages, logger);
  const tools = decodeTools(body.tools);
  const toolMode = decodeToolChoice(body.tool_choice);
  const stream = optBool(body, "stream") ?? false;
  const so = body.stream_options;
  const includeUsage = stream && isRec(so) && so.include_usage === true;
  const echo: ChatEcho = { includeUsage };

  const req: CoreRequest = {
    protocol: "openai-chat",
    model: body.model,
    echoModel: body.model,
    system,
    turns,
    tools,
    toolMode,
    hosted: [],
    stream,
    echo: { ...echo },
  };
  const max =
    optInt(body, "max_completion_tokens") ?? optInt(body, "max_tokens");
  if (max !== undefined) {
    req.maxOutputTokens = max;
  }
  const temperature = optNumber(body, "temperature");
  if (temperature !== undefined) {
    req.temperature = temperature;
  }
  const topP = optNumber(body, "top_p");
  if (topP !== undefined) {
    req.topP = topP;
  }
  const stop = decodeStop(body.stop);
  if (stop) {
    req.stop = stop;
  }
  const ptc = optBool(body, "parallel_tool_calls");
  if (ptc !== undefined) {
    req.parallelToolCalls = ptc;
  }
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    req.reasoningEffort = expectString(
      body.reasoning_effort,
      "reasoning_effort",
    );
  }
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
    req.cacheKey = body.prompt_cache_key;
  }
  return req;
}

export function chatEcho(req: CoreRequest): ChatEcho {
  return { includeUsage: req.echo.includeUsage === true };
}
