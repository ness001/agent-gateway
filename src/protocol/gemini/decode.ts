import { GatewayError } from "../core/errors";
import { ImageInputError, decodeImage, describedPart } from "../core/images";
import { inferGeminiCallIds } from "../core/pairing";
import type {
  CoreLogger,
  CoreRequest,
  HostedSearchTool,
  HostedTool,
  Part,
  TextPart,
  ToolDef,
  ToolMode,
  Turn,
} from "../core/types";
import { geminiSchemaToJsonSchema } from "./schema";

/** Hosted Gemini tools (camelCase and snake_case wire forms). */
export const GEMINI_HOSTED_TOOL_KEYS = [
  "googleSearch",
  "googleSearchRetrieval",
  "urlContext",
] as const;

const SEARCH_KEYS = [
  ["googleSearch", "googleSearch"],
  ["google_search", "googleSearch"],
  ["googleSearchRetrieval", "googleSearchRetrieval"],
  ["google_search_retrieval", "googleSearchRetrieval"],
] as const;
const URL_CONTEXT_KEYS = ["urlContext", "url_context"] as const;

/** Message for a Gemini request whose only tools are search tools. */
export const NO_SEARCH_PROVIDER_MESSAGE =
  'Web search is not configured. Run the "Agent Gateway: Web Search and Fetch" command to choose a search provider.';

export interface GeminiDecodeContext {
  /** Resolved local model id. */
  model: string;
  /** Model name from the route, echoed in `modelVersion`. */
  echoModel: string;
  /** True for `streamGenerateContent`. */
  stream: boolean;
  logger?: CoreLogger;
  /** True when a web search engine is configured. */
  hostedSearch?: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bad(param: string, message: string): GatewayError {
  return new GatewayError("invalid_request", `${param}: ${message}`, { param });
}

function optNum(
  o: Obj,
  key: string,
  path: string,
  integer = false,
): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (integer && !Number.isInteger(v))
  ) {
    throw bad(`${path}.${key}`, `expected ${integer ? "integer" : "number"}`);
  }
  return v;
}

function optStr(o: Obj, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "string") {
    throw bad(`${path}.${key}`, "expected string");
  }
  return v;
}

function partsText(v: unknown, path: string): string {
  if (typeof v === "string") {
    return v;
  }
  if (!isObj(v)) {
    throw bad(path, "expected Content object or string");
  }
  const parts = v.parts;
  if (parts === undefined || parts === null) {
    return "";
  }
  if (!Array.isArray(parts)) {
    throw bad(`${path}.parts`, "expected array");
  }
  return parts
    .map((p, i) => {
      if (!isObj(p)) {
        throw bad(`${path}.parts[${i}]`, "expected object");
      }
      return typeof p.text === "string" ? p.text : "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

/** systemInstruction as a Content object or a plain string. */
function decodeSystem(body: Obj): string[] {
  const si = body.systemInstruction ?? body.system_instruction;
  if (si === undefined || si === null) {
    return [];
  }
  const text = partsText(si, "systemInstruction");
  return text ? [text] : [];
}

function decodeResponseContent(resp: unknown): TextPart[] {
  if (resp === undefined || resp === null) {
    return [];
  }
  const text = typeof resp === "string" ? resp : JSON.stringify(resp);
  return [{ type: "text", text }];
}

function decodePart(
  p: unknown,
  path: string,
  role: Turn["role"],
  logger?: CoreLogger,
): Part | undefined {
  if (!isObj(p)) {
    throw bad(path, "expected object");
  }
  const fd = p.fileData ?? p.file_data;
  if (fd !== undefined) {
    if (!isObj(fd)) {
      throw bad(`${path}.fileData`, "expected object");
    }
    // File references are never fetched; the model gets them as text.
    return describedPart(
      {
        type: "fileData",
        fileUri: fd.fileUri ?? fd.file_uri,
        mimeType: fd.mimeType ?? fd.mime_type,
      },
      "gemini",
      logger,
    );
  }
  const inline = p.inlineData ?? p.inline_data;
  if (inline !== undefined) {
    if (!isObj(inline) || typeof inline.data !== "string") {
      throw bad(`${path}.inlineData.data`, "expected base64 string");
    }
    const mime = inline.mimeType ?? inline.mime_type;
    try {
      const img = decodeImage(inline.data, {
        declaredMime: typeof mime === "string" ? mime : undefined,
        param: `${path}.inlineData`,
        logger,
      });
      return { type: "image", mime: img.mime, data: img.bytes };
    } catch (e) {
      if (e instanceof ImageInputError) {
        throw new GatewayError("invalid_request", e.message, {
          param: e.info.param ?? `${path}.inlineData`,
        });
      }
      throw e;
    }
  }
  const fc = p.functionCall ?? p.function_call;
  if (fc !== undefined) {
    if (!isObj(fc) || typeof fc.name !== "string" || !fc.name) {
      throw bad(`${path}.functionCall.name`, "expected non-empty string");
    }
    if (fc.args !== undefined && fc.args !== null && !isObj(fc.args)) {
      throw bad(`${path}.functionCall.args`, "expected object");
    }
    return {
      type: "toolCall",
      id: typeof fc.id === "string" ? fc.id : "",
      name: fc.name,
      input: isObj(fc.args) ? fc.args : {},
    };
  }
  const fr = p.functionResponse ?? p.function_response;
  if (fr !== undefined) {
    if (!isObj(fr) || typeof fr.name !== "string" || !fr.name) {
      throw bad(`${path}.functionResponse.name`, "expected non-empty string");
    }
    const resp = fr.response;
    const isError =
      isObj(resp) && resp.error !== undefined && resp.output === undefined;
    return {
      type: "toolResult",
      callId: typeof fr.id === "string" ? fr.id : "",
      name: fr.name,
      content: decodeResponseContent(resp),
      isError,
    };
  }
  if (p.text !== undefined) {
    if (typeof p.text !== "string") {
      throw bad(`${path}.text`, "expected string");
    }
    if (p.thought === true) {
      // Replayed thoughts are only meaningful on model turns.
      if (role !== "assistant") {
        return undefined;
      }
      const sig = p.thoughtSignature ?? p.thought_signature;
      return {
        type: "thinking",
        text: p.text,
        ...(typeof sig === "string" ? { signature: sig } : {}),
      };
    }
    return { type: "text", text: p.text };
  }
  // Bare thoughtSignature, executableCode, codeExecutionResult, unknown: ignored.
  return undefined;
}

function decodeContents(body: Obj, logger?: CoreLogger): Turn[] {
  const contents = body.contents;
  if (contents === undefined || contents === null) {
    throw bad("contents", "required");
  }
  const list = Array.isArray(contents) ? contents : [contents];
  if (list.length === 0) {
    throw bad("contents", "must not be empty");
  }
  const turns: Turn[] = [];
  list.forEach((c, i) => {
    const path = `contents[${i}]`;
    if (!isObj(c)) {
      throw bad(path, "expected object");
    }
    const r = c.role;
    let role: Turn["role"];
    if (
      r === undefined ||
      r === null ||
      r === "" ||
      r === "user" ||
      r === "function" ||
      r === "tool"
    ) {
      role = "user";
    } else if (r === "model") {
      role = "assistant";
    } else {
      throw bad(`${path}.role`, `unknown role ${JSON.stringify(r)}`);
    }
    if (c.parts === undefined || c.parts === null) {
      return;
    }
    if (!Array.isArray(c.parts)) {
      throw bad(`${path}.parts`, "expected array");
    }
    const parts: Part[] = [];
    c.parts.forEach((p, j) => {
      const part = decodePart(p, `${path}.parts[${j}]`, role, logger);
      if (part) {
        parts.push(part);
      }
    });
    if (parts.length > 0) {
      turns.push({ role, parts });
    }
  });
  return turns;
}

/** functionDeclarations with `parameters` or `parametersJsonSchema`. */
interface DecodedTools {
  tools: ToolDef[];
  search?: HostedSearchTool;
  urlContext: boolean;
  /** Number of tool entries that carried something other than search. */
  nonSearch: number;
  /** Built-in tools other than search and URL context (code execution, Maps, ...). */
  dropped: string[];
}

function decodeTools(body: Obj): DecodedTools {
  const res: DecodedTools = {
    tools: [],
    urlContext: false,
    nonSearch: 0,
    dropped: [],
  };
  const tools = body.tools;
  if (tools === undefined || tools === null) {
    return res;
  }
  if (!Array.isArray(tools)) {
    throw bad("tools", "expected array");
  }
  const out = res.tools;
  const seen = new Set<string>();
  tools.forEach((t, i) => {
    const path = `tools[${i}]`;
    if (!isObj(t)) {
      throw bad(path, "expected object");
    }
    for (const [key, wireType] of SEARCH_KEYS) {
      if (t[key] !== undefined && t[key] !== null) {
        res.search ??= { kind: "search", wireType };
      }
    }
    for (const key of URL_CONTEXT_KEYS) {
      if (t[key] !== undefined && t[key] !== null) {
        res.urlContext = true;
      }
    }
    const decls = t.functionDeclarations ?? t.function_declarations;
    if (decls === undefined || decls === null) {
      if (Object.keys(t).some((k) => !SEARCH_KEYS.some(([s]) => s === k))) {
        res.nonSearch++;
      }
      for (const k of Object.keys(t)) {
        if (
          !SEARCH_KEYS.some(([s]) => s === k) &&
          !(URL_CONTEXT_KEYS as readonly string[]).includes(k)
        ) {
          res.dropped.push(k);
        }
      }
      return;
    }
    res.nonSearch++;
    if (!Array.isArray(decls)) {
      throw bad(`${path}.functionDeclarations`, "expected array");
    }
    decls.forEach((d, j) => {
      const dp = `${path}.functionDeclarations[${j}]`;
      if (!isObj(d) || typeof d.name !== "string" || !d.name) {
        throw bad(`${dp}.name`, "expected non-empty string");
      }
      if (seen.has(d.name)) {
        throw bad(
          `${dp}.name`,
          `duplicate function name ${JSON.stringify(d.name)}`,
        );
      }
      seen.add(d.name);
      let inputSchema: object;
      const js = d.parametersJsonSchema ?? d.parameters_json_schema;
      if (js !== undefined && js !== null) {
        if (!isObj(js)) {
          throw bad(`${dp}.parametersJsonSchema`, "expected object");
        }
        inputSchema = js;
      } else if (d.parameters !== undefined && d.parameters !== null) {
        inputSchema = geminiSchemaToJsonSchema(
          d.parameters,
          `${dp}.parameters`,
        );
      } else {
        inputSchema = { type: "object", properties: {} };
      }
      out.push({
        name: d.name,
        ...(typeof d.description === "string"
          ? { description: d.description }
          : {}),
        inputSchema,
      });
    });
  });
  return res;
}

/** Hosted tools kept for this request. */
function hostedFor(
  d: DecodedTools,
  hostedSearch: boolean,
  logger?: CoreLogger,
): HostedTool[] {
  const out: HostedTool[] = [];
  if (d.search) {
    if (hostedSearch) {
      out.push(d.search);
    } else if (d.nonSearch === 0) {
      throw new GatewayError("tool_unavailable", NO_SEARCH_PROVIDER_MESSAGE, {
        param: "tools",
      });
    }
  }
  if (d.dropped.length) {
    logger?.info(
      `gemini dropped built-in tools the gateway cannot run: ${[...new Set(d.dropped)].join(", ")}`,
    );
  }
  if (d.search && !hostedSearch) {
    logger?.info(
      "gemini dropped googleSearch: no web search engine is set (run Web Search and Fetch)",
    );
  }
  // urlContext mixed with function declarations is dropped.
  if (d.urlContext && d.tools.length === 0) {
    out.push({ kind: "fetch", wireType: "urlContext" });
  } else if (d.urlContext) {
    logger?.info(
      "gemini dropped urlContext: it cannot be combined with function declarations",
    );
  }
  return out;
}

const MODE_PATH = "toolConfig.functionCallingConfig";

/** AUTO / ANY (+allowedFunctionNames) / NONE; VALIDATED = AUTO. */
function decodeToolMode(body: Obj, tools: ToolDef[]): ToolMode {
  const tc = body.toolConfig ?? body.tool_config;
  if (tc === undefined || tc === null) {
    return { kind: "auto" };
  }
  if (!isObj(tc)) {
    throw bad("toolConfig", "expected object");
  }
  const fcc = tc.functionCallingConfig ?? tc.function_calling_config;
  if (fcc === undefined || fcc === null) {
    return { kind: "auto" };
  }
  if (!isObj(fcc)) {
    throw bad(MODE_PATH, "expected object");
  }
  const mode = fcc.mode ?? "AUTO";
  const allowedRaw = fcc.allowedFunctionNames ?? fcc.allowed_function_names;
  let allowed: string[] | undefined;
  if (allowedRaw !== undefined && allowedRaw !== null) {
    if (
      !Array.isArray(allowedRaw) ||
      !allowedRaw.every((x) => typeof x === "string")
    ) {
      throw bad(`${MODE_PATH}.allowedFunctionNames`, "expected string array");
    }
    const known = new Set(tools.map((t) => t.name));
    for (const n of allowedRaw as string[]) {
      if (!known.has(n)) {
        throw bad(
          `${MODE_PATH}.allowedFunctionNames`,
          `unknown function ${JSON.stringify(n)}`,
        );
      }
    }
    allowed = allowedRaw as string[];
  }
  switch (mode) {
    case "AUTO":
    case "VALIDATED":
    case "MODE_UNSPECIFIED":
      return { kind: "auto" };
    case "NONE":
      return { kind: "none" };
    case "ANY":
      return allowed && allowed.length > 0
        ? { kind: "required", only: allowed }
        : { kind: "required" };
    default:
      throw bad(
        `${MODE_PATH}.mode`,
        `unsupported mode ${JSON.stringify(mode)}; expected AUTO, ANY, NONE or VALIDATED`,
      );
  }
}

type GenFields = Pick<
  CoreRequest,
  "maxOutputTokens" | "stop" | "temperature" | "topP" | "reasoningEffort"
> & { echo: Record<string, unknown> };

/**
 * generationConfig fields are accepted. Fields with no CoreRequest
 * slot (topK, candidateCount, responseMimeType, responseSchema presence,
 * thinkingBudget, includeThoughts) land in `echo` for the encoder and the
 * settings log line. candidateCount > 1 is accepted; one candidate is returned.
 */
function decodeGeneration(body: Obj): GenFields {
  const gc = body.generationConfig ?? body.generation_config;
  const out: GenFields = { echo: {} };
  if (gc === undefined || gc === null) {
    return out;
  }
  const p = "generationConfig";
  if (!isObj(gc)) {
    throw bad(p, "expected object");
  }
  // Forwarded only when sent, unchanged.
  const max = optNum(gc, "maxOutputTokens", p, true);
  if (max !== undefined) {
    if (max < 1) {
      throw bad(`${p}.maxOutputTokens`, "must be >= 1");
    }
    out.maxOutputTokens = max;
  }
  const temperature = optNum(gc, "temperature", p);
  if (temperature !== undefined) {
    out.temperature = temperature;
  }
  const topP = optNum(gc, "topP", p);
  if (topP !== undefined) {
    out.topP = topP;
  }
  const topK = optNum(gc, "topK", p);
  if (topK !== undefined) {
    out.echo.topK = topK;
  }
  const stops = gc.stopSequences;
  if (stops !== undefined && stops !== null) {
    if (!Array.isArray(stops) || !stops.every((s) => typeof s === "string")) {
      throw bad(`${p}.stopSequences`, "expected string array");
    }
    if (stops.length > 0) {
      out.stop = stops as string[];
    }
  }
  const cc = optNum(gc, "candidateCount", p, true);
  if (cc !== undefined) {
    if (cc < 1) {
      throw bad(`${p}.candidateCount`, "must be >= 1");
    }
    out.echo.candidateCount = cc;
  }
  const mime = optStr(gc, "responseMimeType", p);
  if (mime !== undefined) {
    out.echo.responseMimeType = mime;
  }
  const rs = gc.responseSchema ?? gc.responseJsonSchema;
  if (rs !== undefined && rs !== null) {
    out.echo.responseSchema = true;
  }
  const tc = gc.thinkingConfig;
  if (tc !== undefined && tc !== null) {
    const tp = `${p}.thinkingConfig`;
    if (!isObj(tc)) {
      throw bad(tp, "expected object");
    }
    const budget = optNum(tc, "thinkingBudget", tp, true);
    if (budget !== undefined) {
      out.echo.thinkingBudget = budget;
    }
    if (tc.includeThoughts !== undefined && tc.includeThoughts !== null) {
      if (typeof tc.includeThoughts !== "boolean") {
        throw bad(`${tp}.includeThoughts`, "expected boolean");
      }
      out.echo.includeThoughts = tc.includeThoughts;
    }
    const level = optStr(tc, "thinkingLevel", tp);
    if (
      level !== undefined &&
      level.toUpperCase() !== "THINKING_LEVEL_UNSPECIFIED"
    ) {
      // Effort passes through unchanged (lower-cased enum).
      out.reasoningEffort = level.toLowerCase();
    }
  }
  return out;
}

/**
 * GenerateContentRequest -> CoreRequest. Throws `GatewayError` on invalid
 * input. Function-call ids missing on the wire are inferred;
 * pairing repair itself runs later in the pipeline.
 */
export function decodeGeminiRequest(
  body: unknown,
  ctx: GeminiDecodeContext,
): CoreRequest {
  if (!isObj(body)) {
    throw bad("body", "expected object");
  }
  const decodedTools = decodeTools(body);
  const tools = decodedTools.tools;
  const hosted = hostedFor(decodedTools, ctx.hostedSearch === true, ctx.logger);
  const toolMode = decodeToolMode(body, tools);
  const turns = inferGeminiCallIds(decodeContents(body, ctx.logger));
  const gen = decodeGeneration(body);
  const req: CoreRequest = {
    protocol: "gemini",
    model: ctx.model,
    echoModel: ctx.echoModel,
    system: decodeSystem(body),
    turns,
    tools,
    toolMode,
    hosted,
    stream: ctx.stream,
    echo: gen.echo,
  };
  if (gen.maxOutputTokens !== undefined) {
    req.maxOutputTokens = gen.maxOutputTokens;
  }
  if (gen.stop !== undefined) {
    req.stop = gen.stop;
  }
  if (gen.temperature !== undefined) {
    req.temperature = gen.temperature;
  }
  if (gen.topP !== undefined) {
    req.topP = gen.topP;
  }
  if (gen.reasoningEffort !== undefined) {
    req.reasoningEffort = gen.reasoningEffort;
  }
  const cached = body.cachedContent;
  if (typeof cached === "string" && cached) {
    req.cacheKey = cached;
  }
  return req;
}
