import { GatewayError } from "../core/errors";
import {
  ImageInputError,
  decodeImage,
  describedPart,
  imageLinkPart,
  omittedData,
  parseDataUrl,
} from "../core/images";
import type {
  CoreLogger,
  CoreRequest,
  HostedFetchTool,
  HostedSearchTool,
  ImagePart,
  Part,
  TextPart,
  ToolDef,
  ToolMode,
  Turn,
} from "../core/types";

export const MISSING_MODEL_MESSAGE = "Request body must specify a model.";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bad(message: string, param?: string): GatewayError {
  return new GatewayError(
    "invalid_request",
    param ? `${param}: ${message}` : message,
    param ? { param } : {},
  );
}

function unsupported(message: string, param: string): GatewayError {
  return new GatewayError("unsupported", `${param}: ${message}`, { param });
}

function needRec(v: unknown, path: string): Rec {
  if (!isRec(v)) {
    throw bad("expected an object", path);
  }
  return v;
}

function needStr(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw bad("expected a string", path);
  }
  return v;
}

function needArr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) {
    throw bad("expected an array", path);
  }
  return v;
}

function optNum(
  v: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw bad(`expected a number between ${min} and ${max}`, path);
  }
  return v;
}

function optPosInt(v: unknown, path: string): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw bad("expected a positive integer", path);
  }
  return v;
}

/** Hosted (server) web search tool type, e.g. `web_search_20250305`. */
export const WEB_SEARCH_TYPE_RE = /^web_search_\d{8}$/;
/** Hosted web fetch tool type, e.g. `web_fetch_20250910`. */
export const WEB_FETCH_TYPE_RE = /^web_fetch_\d{8}$/;

// ---- Content blocks ----

function decodeImageBlock(
  b: Rec,
  path: string,
  logger?: CoreLogger,
): ImagePart | TextPart {
  const src = needRec(b.source, `${path}.source`);
  const kind = src.type;
  try {
    if (kind === "base64") {
      const data = needStr(src.data, `${path}.source.data`);
      const mime =
        typeof src.media_type === "string" ? src.media_type : undefined;
      const img = decodeImage(data, {
        declaredMime: mime,
        param: `${path}.source.data`,
      });
      return { type: "image", mime: img.mime, data: img.bytes };
    }
    if (kind === "url") {
      const url = needStr(src.url, `${path}.source.url`);
      if (parseDataUrl(url)) {
        const img = decodeImage(url, { param: `${path}.source.url` });
        return { type: "image", mime: img.mime, data: img.bytes };
      }
      // Downloaded by the handler; the text stays if that fails.
      return imageLinkPart({ type: "image", url }, url, "anthropic", logger);
    }
  } catch (e) {
    if (e instanceof ImageInputError) {
      throw bad(e.message.replace(/\.$/, ""), e.info.param ?? path);
    }
    throw e;
  }
  return describedPart(sourceFields("image", src), "anthropic", logger);
}

/** Reference fields of a non-inline source, with inline data omitted. */
function sourceFields(type: string, src: Rec): Rec {
  return {
    type,
    source_type: typeof src.type === "string" ? src.type : undefined,
    url: typeof src.url === "string" ? src.url : undefined,
    file_id: typeof src.file_id === "string" ? src.file_id : undefined,
    media_type: typeof src.media_type === "string" ? src.media_type : undefined,
    data: typeof src.data === "string" ? omittedData(src.data) : undefined,
  };
}

/** Document blocks: plain-text sources pass through, others become text. */
function decodeDocumentBlock(
  b: Rec,
  path: string,
  logger?: CoreLogger,
): TextPart {
  const src = needRec(b.source, `${path}.source`);
  if (src.type === "text" && typeof src.data === "string") {
    return { type: "text", text: src.data };
  }
  const fields = sourceFields("document", src);
  if (typeof b.title === "string") {
    fields.title = b.title;
  }
  return describedPart(fields, "anthropic", logger);
}

function decodeToolResultContent(
  v: unknown,
  path: string,
  logger?: CoreLogger,
): Array<TextPart | ImagePart> {
  if (v === undefined || v === null) {
    return [];
  }
  if (typeof v === "string") {
    return v ? [{ type: "text", text: v }] : [];
  }
  const out: Array<TextPart | ImagePart> = [];
  needArr(v, path).forEach((raw, i) => {
    const p = `${path}[${i}]`;
    const b = needRec(raw, p);
    if (b.type === "text") {
      out.push({ type: "text", text: needStr(b.text, `${p}.text`) });
    } else if (b.type === "image") {
      out.push(decodeImageBlock(b, p, logger));
    } else if (b.type === "document") {
      out.push(decodeDocumentBlock(b, p, logger));
    } else {
      throw unsupported(
        `content block type ${JSON.stringify(b.type)} is not supported inside tool_result`,
        `${p}.type`,
      );
    }
  });
  return out;
}

function decodeBlock(
  raw: unknown,
  path: string,
  role: "user" | "assistant",
  logger?: CoreLogger,
): Part | undefined {
  const b = needRec(raw, path);
  switch (b.type) {
    case "text":
      return { type: "text", text: needStr(b.text, `${path}.text`) };
    case "image":
      return decodeImageBlock(b, path, logger);
    case "document":
      return decodeDocumentBlock(b, path, logger);
    case "tool_use": {
      if (role !== "assistant") {
        throw bad("tool_use blocks are only valid in assistant messages", path);
      }
      const input = b.input === undefined ? {} : b.input;
      return {
        type: "toolCall",
        id: needStr(b.id, `${path}.id`),
        name: needStr(b.name, `${path}.name`),
        input: needRec(input, `${path}.input`),
      };
    }
    case "tool_result": {
      if (role !== "user") {
        throw bad("tool_result blocks are only valid in user messages", path);
      }
      if (b.is_error !== undefined && typeof b.is_error !== "boolean") {
        throw bad("expected a boolean", `${path}.is_error`);
      }
      return {
        type: "toolResult",
        callId: needStr(b.tool_use_id, `${path}.tool_use_id`),
        content: decodeToolResultContent(b.content, `${path}.content`, logger),
        isError: b.is_error === true,
      };
    }
    case "thinking":
      // Replayed thinking: accepted; the LM API has no input part.
      return typeof b.signature === "string"
        ? {
            type: "thinking",
            text: typeof b.thinking === "string" ? b.thinking : "",
            signature: b.signature,
          }
        : {
            type: "thinking",
            text: typeof b.thinking === "string" ? b.thinking : "",
          };
    case "redacted_thinking":
      return undefined;
    case "server_tool_use":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
      // Earlier hosted search history: the model already saw the answer text
      // that followed, so the blocks are dropped.
      return undefined;
    default:
      throw unsupported(
        `content block type ${JSON.stringify(b.type)} is not supported`,
        `${path}.type`,
      );
  }
}

/**
 * Claude Code sends `role: "system"` entries inside `messages` (environment
 * context); their text joins the system prompt in order.
 */
function decodeMessages(
  v: unknown,
  logger?: CoreLogger,
): { turns: Turn[]; system: string[] } {
  const list = needArr(v, "messages");
  const system: string[] = [];
  const turns: Turn[] = [];
  list.forEach((raw, i) => {
    const path = `messages[${i}]`;
    const m = needRec(raw, path);
    if (m.role === "system") {
      system.push(...decodeSystem(m.content, `${path}.content`));
      return;
    }
    if (m.role !== "user" && m.role !== "assistant") {
      throw bad('expected "user" or "assistant"', `${path}.role`);
    }
    const role = m.role;
    const parts: Part[] = [];
    if (typeof m.content === "string") {
      parts.push({ type: "text", text: m.content });
    } else {
      needArr(m.content, `${path}.content`).forEach((b, j) => {
        const p = decodeBlock(b, `${path}.content[${j}]`, role, logger);
        if (p) {
          parts.push(p);
        }
      });
    }
    // Anthropic combines consecutive messages with the same role. Claude Code
    // can replay parallel tool calls/results as separate message fragments.
    const previous = turns.at(-1);
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      turns.push({ role, parts });
    }
  });
  return { turns, system };
}

function decodeSystem(v: unknown, param = "system"): string[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (typeof v === "string") {
    return v ? [v] : [];
  }
  return needArr(v, param).map((raw, i) => {
    const b = needRec(raw, `${param}[${i}]`);
    if (b.type !== "text") {
      throw bad('expected a "text" block', `${param}[${i}].type`);
    }
    return needStr(b.text, `${param}[${i}].text`);
  });
}

// ---- Tools ----

interface DecodedTools {
  tools: ToolDef[];
  /** Hosted tools by wire name (`web_search`, `web_fetch`). */
  hosted: Map<
    string,
    { tool?: HostedSearchTool | HostedFetchTool; type: string }
  >;
}

function optStrList(v: unknown, path: string): string[] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  return needArr(v, path).map((x, i) => needStr(x, `${path}[${i}]`));
}

function decodeHostedSearch(
  t: Rec,
  type: string,
  path: string,
): HostedSearchTool {
  const tool: HostedSearchTool = { kind: "search", wireType: type };
  const maxUses = optPosInt(t.max_uses, `${path}.max_uses`);
  if (maxUses !== undefined) {
    tool.maxUses = maxUses;
  }
  const allowed = optStrList(t.allowed_domains, `${path}.allowed_domains`);
  if (allowed) {
    tool.allowedDomains = allowed;
  }
  const blocked = optStrList(t.blocked_domains, `${path}.blocked_domains`);
  if (blocked) {
    tool.blockedDomains = blocked;
  }
  return tool;
}

function decodeTools(v: unknown): DecodedTools {
  const out: DecodedTools = { tools: [], hosted: new Map() };
  if (v === undefined || v === null) {
    return out;
  }
  needArr(v, "tools").forEach((raw, i) => {
    const path = `tools[${i}]`;
    const t = needRec(raw, path);
    const type = t.type;
    if (type !== undefined && type !== null && type !== "custom") {
      if (typeof type === "string" && WEB_SEARCH_TYPE_RE.test(type)) {
        const name = typeof t.name === "string" ? t.name : "web_search";
        out.hosted.set(name, {
          tool: decodeHostedSearch(t, type, path),
          type,
        });
        return;
      }
      if (typeof type === "string" && WEB_FETCH_TYPE_RE.test(type)) {
        // Run by the gateway with the configured engine; without one it is
        // dropped when optional, 400 tool_unavailable when forced.
        const name = typeof t.name === "string" ? t.name : "web_fetch";
        const s = decodeHostedSearch(t, type, path);
        const tool: HostedFetchTool = {
          kind: "fetch",
          wireType: type,
          asTool: true,
        };
        if (s.maxUses !== undefined) {
          tool.maxUses = s.maxUses;
        }
        if (s.allowedDomains) {
          tool.allowedDomains = s.allowedDomains;
        }
        if (s.blockedDomains) {
          tool.blockedDomains = s.blockedDomains;
        }
        out.hosted.set(name, { tool, type });
        return;
      }
      throw unsupported(
        `server tool type ${JSON.stringify(type)} is not supported`,
        `${path}.type`,
      );
    }
    const name = needStr(t.name, `${path}.name`);
    if (!name) {
      throw bad("must not be empty", `${path}.name`);
    }
    const def: ToolDef = {
      name,
      inputSchema: needRec(t.input_schema, `${path}.input_schema`),
    };
    if (t.description !== undefined && t.description !== null) {
      def.description = needStr(t.description, `${path}.description`);
    }
    out.tools.push(def);
  });
  return out;
}

function decodeToolChoice(
  v: unknown,
  decoded: DecodedTools,
  hostedSearch: boolean,
): { mode: ToolMode; parallel?: boolean } {
  const tools = decoded.tools;
  if (v === undefined || v === null) {
    return { mode: { kind: "auto" } };
  }
  const c = needRec(v, "tool_choice");
  let parallel: boolean | undefined;
  if (c.disable_parallel_tool_use !== undefined) {
    if (typeof c.disable_parallel_tool_use !== "boolean") {
      throw bad("expected a boolean", "tool_choice.disable_parallel_tool_use");
    }
    parallel = !c.disable_parallel_tool_use;
  }
  const out = (mode: ToolMode) =>
    parallel === undefined ? { mode } : { mode, parallel };
  switch (c.type) {
    case "auto":
      return out({ kind: "auto" });
    case "none":
      return out({ kind: "none" });
    case "any":
      return out({ kind: "required" });
    case "tool": {
      const name = needStr(c.name, "tool_choice.name");
      const h = decoded.hosted.get(name);
      if (h && !tools.some((t) => t.name === name)) {
        if (!h.tool || !hostedSearch) {
          // A forced hosted tool that cannot run.
          throw new GatewayError(
            "tool_unavailable",
            `tool_choice.name: hosted tool ${h.type} is not available; configure a provider with the "Agent Gateway: Web Search and Fetch" command`,
            { param: "tool_choice.name" },
          );
        }
        h.tool.forced = true;
        return out({ kind: "auto" });
      }
      if (!tools.some((t) => t.name === name)) {
        throw bad(
          `tool ${JSON.stringify(name)} is not in tools`,
          "tool_choice.name",
        );
      }
      return out({ kind: "required", only: [name] });
    }
    default:
      throw bad(
        'expected one of "auto", "any", "tool", "none"',
        "tool_choice.type",
      );
  }
}

// ---- Thinking / effort ----

/** Effort values passed through unchanged. */
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Maps `thinking` (and `output_config.effort`) to a reasoning effort.
 * An explicit `output_config.effort` wins and is passed unchanged.
 * `enabled` maps the budget to low (< 4096), medium (< 16384) or high.
 * `adaptive` leaves the model default; `disabled` sends no effort.
 * `core/lmRequest` only forwards a value the model advertises.
 */
export function reasoningEffortFor(body: Rec): string | undefined {
  const oc = body.output_config;
  if (oc !== undefined && oc !== null) {
    const effort = needRec(oc, "output_config").effort;
    if (effort !== undefined && effort !== null) {
      const e = needStr(effort, "output_config.effort");
      if (!EFFORT_RE.test(e)) {
        throw bad("invalid effort value", "output_config.effort");
      }
      return e;
    }
  }
  const t = body.thinking;
  if (t === undefined || t === null) {
    return undefined;
  }
  const th = needRec(t, "thinking");
  switch (th.type) {
    case "enabled": {
      const budget = optPosInt(th.budget_tokens, "thinking.budget_tokens");
      if (budget === undefined) {
        throw bad(
          "required when thinking is enabled",
          "thinking.budget_tokens",
        );
      }
      return budget < 4096 ? "low" : budget < 16384 ? "medium" : "high";
    }
    case "adaptive":
    case "disabled":
      return undefined;
    default:
      throw bad(
        'expected one of "enabled", "adaptive", "disabled"',
        "thinking.type",
      );
  }
}

function decodeStop(v: unknown): string[] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const list = needArr(v, "stop_sequences").map((s, i) =>
    needStr(s, `stop_sequences[${i}]`),
  );
  return list.length ? list : undefined;
}

export interface DecodeOptions {
  /** count_tokens bodies have no max_tokens / stream. */
  countTokens?: boolean;
  /** True when a web search engine is configured. */
  hostedSearch?: boolean;
  logger?: CoreLogger;
}

/**
 * Anthropic Messages body -> CoreRequest. Throws GatewayError (400) for
 * invalid input. `model` is the requested id; the handler resolves it.
 */
export function decodeMessagesRequest(
  body: unknown,
  opts: DecodeOptions = {},
): CoreRequest {
  if (!isRec(body)) {
    throw bad("Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new GatewayError("invalid_request", MISSING_MODEL_MESSAGE, {
      param: "model",
    });
  }
  const model = body.model;
  if (body.messages === undefined) {
    throw bad("field required", "messages");
  }
  const decoded = decodeMessages(body.messages, opts.logger);
  const turns = decoded.turns;
  const system = [...decodeSystem(body.system), ...decoded.system];
  const decodedTools = decodeTools(body.tools);
  const tools = decodedTools.tools;
  const hostedSearch = opts.hostedSearch === true;
  const choice = decodeToolChoice(body.tool_choice, decodedTools, hostedSearch);
  // Without a provider an optional hosted tool is dropped.
  const hosted = hostedSearch
    ? [...decodedTools.hosted.values()].flatMap((h) => (h.tool ? [h.tool] : []))
    : [];
  const droppedHosted = [...decodedTools.hosted.values()]
    .filter((h) => !hostedSearch || !h.tool)
    .map((h) => h.type);
  if (droppedHosted.length) {
    opts.logger?.info(
      `anthropic dropped server tools: ${[...new Set(droppedHosted)].join(", ")} (no web search engine is set; run Web Search and Fetch)`,
    );
  }
  if (
    body.stream !== undefined &&
    body.stream !== null &&
    typeof body.stream !== "boolean"
  ) {
    throw bad("expected a boolean", "stream");
  }
  // Forward the client's limit unchanged, or none.
  const maxOutputTokens = opts.countTokens
    ? undefined
    : optPosInt(body.max_tokens, "max_tokens");
  const temperature = optNum(body.temperature, "temperature", 0, 2);
  const topP = optNum(body.top_p, "top_p", 0, 1);
  optNum(body.top_k, "top_k", 0, Number.MAX_SAFE_INTEGER);
  const stop = decodeStop(body.stop_sequences);
  if (body.metadata !== undefined && body.metadata !== null) {
    needRec(body.metadata, "metadata"); // accepted and ignored
  }
  const reasoningEffort = reasoningEffortFor(body);

  const req: CoreRequest = {
    protocol: "anthropic",
    model,
    echoModel: model,
    system,
    turns,
    tools,
    toolMode: choice.mode,
    hosted,
    stream: !opts.countTokens && body.stream === true,
    echo: {},
  };
  if (maxOutputTokens !== undefined) {
    req.maxOutputTokens = maxOutputTokens;
  }
  if (stop) {
    req.stop = stop;
  }
  if (temperature !== undefined) {
    req.temperature = temperature;
  }
  if (topP !== undefined) {
    req.topP = topP;
  }
  if (reasoningEffort !== undefined) {
    req.reasoningEffort = reasoningEffort;
  }
  if (choice.parallel !== undefined) {
    req.parallelToolCalls = choice.parallel;
  }
  if (isRec(body.thinking) && typeof body.thinking.type === "string") {
    req.echo.thinking = body.thinking.type;
  }
  return req;
}
