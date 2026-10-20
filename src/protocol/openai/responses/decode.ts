import { GatewayError } from "../../core/errors";
import {
  ImageInputError,
  decodeImage,
  describedPart,
  imageLinkPart,
  omittedData,
} from "../../core/images";
import type {
  CoreLogger,
  CoreRequest,
  HostedSearchTool,
  ImagePart,
  Part,
  TextPart,
  ToolDef,
  ToolMode,
  Turn,
} from "../../core/types";
import { badParam, unsupported } from "./errors";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Include value that asks for reasoning replay data in output items. */
export const INCLUDE_ENCRYPTED_REASONING = "reasoning.encrypted_content";

/** Extra decode results that are not part of CoreRequest. */
export interface ResponsesDecoded {
  core: CoreRequest;
  /** `include` contains `reasoning.encrypted_content`. */
  includeEncryptedReasoning: boolean;
  /** `reasoning.summary` requested by the client (echoed). */
  reasoningSummary: string | null;
  /** LM tool name -> namespace and wire name, for `namespace` tools. */
  namespaced: Map<string, NamespacedName>;
  /** LM tool names that are `custom` (freeform text input) tools. */
  custom: Set<string>;
  /** Calls to `tool_search` become `tool_search_call` items. */
  toolSearch: boolean;
}

export interface DecodeOptions {
  logger?: CoreLogger;
  /** True when a web search engine is configured. */
  hostedSearch?: boolean;
}

/** Responses hosted web search tool types (incl. preview and dated forms). */
export const RESPONSES_WEB_SEARCH_RE =
  /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/;

function decodeHostedSearch(
  raw: Rec,
  type: string,
  p: string,
): HostedSearchTool | undefined {
  if (raw.external_web_access === false) {
    // Cached-only search is not offered; drop the tool.
    return undefined;
  }
  const tool: HostedSearchTool = { kind: "search", wireType: type };
  const filters = raw.filters;
  if (
    isRec(filters) &&
    filters.allowed_domains !== undefined &&
    filters.allowed_domains !== null
  ) {
    const list = filters.allowed_domains;
    if (!Array.isArray(list)) {
      throw badParam(
        `Invalid type for '${p}.filters.allowed_domains': expected an array.`,
        `${p}.filters.allowed_domains`,
      );
    }
    tool.allowedDomains = list.map((d, i) =>
      str(d, `${p}.filters.allowed_domains[${i}]`),
    );
  }
  return tool;
}

function str(v: unknown, param: string): string {
  if (typeof v !== "string") {
    throw badParam(`Invalid type for '${param}': expected a string.`, param);
  }
  return v;
}

function optStr(v: unknown, param: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, param);
}

function optInt(v: unknown, param: string, min = 1): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw badParam(`Invalid '${param}': expected an integer >= ${min}.`, param);
  }
  return v;
}

function optNum(v: unknown, param: string): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw badParam(`Invalid type for '${param}': expected a number.`, param);
  }
  return v;
}

function optBool(v: unknown, param: string): boolean | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "boolean") {
    throw badParam(`Invalid type for '${param}': expected a boolean.`, param);
  }
  return v;
}

const strOrNone = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

function image(
  part: Rec,
  param: string,
  logger?: CoreLogger,
): ImagePart | TextPart {
  const fileId = strOrNone(part.file_id);
  if (fileId !== undefined && part.image_url == null) {
    return describedPart(
      { type: "input_image", file_id: fileId, detail: strOrNone(part.detail) },
      "openai responses",
      logger,
    );
  }
  const url = str(part.image_url, `${param}.image_url`);
  if (!url.trimStart().startsWith("data:")) {
    // Downloaded by the handler; the text stays if that fails.
    return imageLinkPart(
      { type: "input_image", image_url: url, detail: strOrNone(part.detail) },
      url,
      "openai responses",
      logger,
    );
  }
  try {
    const img = decodeImage(url, { param: `${param}.image_url`, logger });
    return { type: "image", mime: img.mime, data: img.bytes };
  } catch (e) {
    if (e instanceof ImageInputError) {
      throw badParam(e.message, e.info.param ?? `${param}.image_url`);
    }
    throw e;
  }
}

/** Message content (string or parts) to core parts. */
function contentParts(
  content: unknown,
  role: string,
  param: string,
  logger?: CoreLogger,
): Array<TextPart | ImagePart> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    throw badParam(
      `Invalid type for '${param}': expected a string or an array of content parts.`,
      param,
    );
  }
  const out: Array<TextPart | ImagePart> = [];
  content.forEach((raw, i) => {
    const p = `${param}[${i}]`;
    if (!isRec(raw)) {
      throw badParam(`Invalid '${p}': expected an object.`, p);
    }
    switch (raw.type) {
      case "input_text":
      case "output_text":
      case "text":
        out.push({ type: "text", text: str(raw.text, `${p}.text`) });
        break;
      case "refusal":
        out.push({ type: "text", text: str(raw.refusal, `${p}.refusal`) });
        break;
      case "input_image":
        if (role === "assistant" || role === "system" || role === "developer") {
          throw badParam(
            `Invalid '${p}': input_image is not allowed in ${role} messages.`,
            p,
          );
        }
        out.push(image(raw, p, logger));
        break;
      case "input_file":
        out.push(
          describedPart(
            {
              type: "input_file",
              file_id: strOrNone(raw.file_id),
              file_url: strOrNone(raw.file_url),
              filename: strOrNone(raw.filename),
              file_data:
                typeof raw.file_data === "string"
                  ? omittedData(raw.file_data)
                  : undefined,
            },
            "openai responses",
            logger,
          ),
        );
        break;
      case "input_audio":
        out.push(
          describedPart(
            {
              type: "input_audio",
              format: isRec(raw.input_audio)
                ? strOrNone(raw.input_audio.format)
                : undefined,
              data:
                isRec(raw.input_audio) &&
                typeof raw.input_audio.data === "string"
                  ? omittedData(raw.input_audio.data)
                  : undefined,
            },
            "openai responses",
            logger,
          ),
        );
        break;
      default:
        throw badParam(
          `Invalid '${p}.type': unsupported content type ${JSON.stringify(raw.type)}.`,
          `${p}.type`,
        );
    }
  });
  return out;
}

function parseArgs(text: string, param: string): object {
  if (text.trim() === "") {
    return {};
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw badParam(
      `Invalid '${param}': arguments must be a JSON object.`,
      param,
    );
  }
  if (!isRec(v)) {
    throw badParam(
      `Invalid '${param}': arguments must be a JSON object.`,
      param,
    );
  }
  return v;
}

function toolOutput(
  output: unknown,
  param: string,
  logger?: CoreLogger,
): Array<TextPart | ImagePart> {
  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }
  return contentParts(output, "user", param, logger);
}

class TurnBuilder {
  readonly turns: Turn[] = [];
  push(role: Turn["role"], parts: Part[]): void {
    if (parts.length === 0) {
      return;
    }
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      this.turns.push({ role, parts: [...parts] });
    }
  }
}

function reasoningText(item: Rec): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"] as const) {
    const list = item[key];
    if (Array.isArray(list)) {
      for (const s of list) {
        if (isRec(s) && typeof s.text === "string") {
          parts.push(s.text);
        }
      }
    }
  }
  return parts.join("\n\n");
}

function decodeInput(
  input: unknown,
  system: string[],
  logger?: CoreLogger,
  searchLoaded: unknown[] = [],
): Turn[] {
  const b = new TurnBuilder();
  const skippedItems: string[] = [];
  if (input === undefined || input === null) {
    return b.turns;
  }
  if (typeof input === "string") {
    b.push("user", [{ type: "text", text: input }]);
    return b.turns;
  }
  if (!Array.isArray(input)) {
    throw badParam(
      "Invalid type for 'input': expected a string or an array of input items.",
      "input",
    );
  }
  input.forEach((raw, i) => {
    const p = `input[${i}]`;
    if (!isRec(raw)) {
      throw badParam(`Invalid '${p}': expected an object.`, p);
    }
    const type = raw.type ?? (raw.role !== undefined ? "message" : undefined);
    switch (type) {
      case "message": {
        const role = str(raw.role, `${p}.role`);
        const parts = contentParts(raw.content, role, `${p}.content`, logger);
        if (role === "system" || role === "developer") {
          const text = parts
            .map((x) => (x.type === "text" ? x.text : ""))
            .join("\n");
          if (text) {
            system.push(text);
          }
        } else if (role === "user") {
          b.push("user", parts);
        } else if (role === "assistant") {
          b.push("assistant", parts);
        } else {
          throw badParam(
            `Invalid '${p}.role': expected one of "system", "developer", "user", "assistant".`,
            `${p}.role`,
          );
        }
        break;
      }
      case "function_call": {
        const id = str(raw.call_id, `${p}.call_id`);
        const bare = str(raw.name, `${p}.name`);
        const name =
          typeof raw.namespace === "string" && raw.namespace
            ? namespacedToolName(raw.namespace, bare)
            : bare;
        const args = raw.arguments ?? "";
        const input =
          typeof args === "string"
            ? parseArgs(args, `${p}.arguments`)
            : isRec(args)
              ? args
              : parseArgs(str(args, `${p}.arguments`), `${p}.arguments`);
        b.push("assistant", [{ type: "toolCall", id, name, input }]);
        break;
      }
      case "custom_tool_call": {
        const id = str(raw.call_id, `${p}.call_id`);
        const bare = str(raw.name, `${p}.name`);
        const name =
          typeof raw.namespace === "string" && raw.namespace
            ? namespacedToolName(raw.namespace, bare)
            : bare;
        const text = typeof raw.input === "string" ? raw.input : "";
        b.push("assistant", [
          { type: "toolCall", id, name, input: { [CUSTOM_INPUT_KEY]: text } },
        ]);
        break;
      }
      case "tool_search_call": {
        if (raw.execution === "server") {
          break;
        }
        const id = str(raw.call_id, `${p}.call_id`);
        const args = raw.arguments;
        const input = isRec(args)
          ? args
          : typeof args === "string"
            ? parseArgs(args, `${p}.arguments`)
            : {};
        b.push("assistant", [
          { type: "toolCall", id, name: TOOL_SEARCH_NAME, input },
        ]);
        break;
      }
      case "tool_search_output": {
        if (raw.execution === "server" || typeof raw.call_id !== "string") {
          break;
        }
        const loaded = Array.isArray(raw.tools) ? raw.tools : [];
        const names = loaded
          .map((t) => (isRec(t) && typeof t.name === "string" ? t.name : ""))
          .filter(Boolean);
        searchLoaded.push(...loaded);
        b.push("user", [
          {
            type: "toolResult",
            callId: raw.call_id,
            content: [
              {
                type: "text",
                text: names.length
                  ? `Loaded tools: ${names.join(", ")}`
                  : "No tools matched.",
              },
            ],
            isError: false,
          },
        ]);
        break;
      }
      case "custom_tool_call_output":
      case "function_call_output": {
        const callId = str(raw.call_id, `${p}.call_id`);
        b.push("user", [
          {
            type: "toolResult",
            callId,
            content: toolOutput(raw.output, `${p}.output`, logger),
            isError: false,
          },
        ]);
        break;
      }
      case "reasoning": {
        const text = reasoningText(raw);
        const sig =
          typeof raw.encrypted_content === "string"
            ? raw.encrypted_content
            : undefined;
        if (text || sig) {
          b.push("assistant", [
            sig !== undefined
              ? { type: "thinking", text, signature: sig }
              : { type: "thinking", text },
          ]);
        }
        break;
      }
      case "web_search_call":
        // Tolerated history: the search already happened in an earlier turn.
        break;
      case "additional_tools":
        // Tools made available at this point of the conversation (Codex sends
        // its tool groups here); they join the request's tool list.
        if (Array.isArray(raw.tools)) {
          searchLoaded.push(...raw.tools);
        }
        break;
      case "configuration_update":
      case "compaction":
      case "compaction_trigger":
        // State for the hosted API; nothing to forward to the LM API.
        break;
      case "item_reference":
        throw unsupported(
          "item_reference input items are not supported (responses are not stored).",
          p,
        );
      default:
        if (typeof type === "string" && type) {
          // History of built-in tools the LM API cannot run (shell, MCP,
          // code interpreter, ...): skipped so the rest of the turn still works.
          skippedItems.push(type);
          break;
        }
        throw badParam(
          `Invalid '${p}.type': unsupported input item type ${JSON.stringify(type)}.`,
          `${p}.type`,
        );
    }
  });
  if (skippedItems.length) {
    logger?.info(
      `openai-responses skipped input item types: ${[...new Set(skippedItems)].join(", ")}`,
    );
  }
  return b.turns;
}

interface DecodedTools {
  tools: ToolDef[];
  hosted: HostedSearchTool[];
  /** LM tool name -> namespace and wire name, for `namespace` tools. */
  namespaced: Map<string, NamespacedName>;
  /** LM tool names that are `custom` (freeform text input) tools. */
  custom: Set<string>;
  /** A client-executed `tool_search` tool is offered. */
  toolSearch: boolean;
  /** Tool types that cannot run through the LM API and were dropped. */
  dropped: string[];
}

/** LM tool name of the client-executed `tool_search` tool. */
export const TOOL_SEARCH_NAME = "tool_search";

/** Single string parameter carrying a custom tool's freeform input. */
export const CUSTOM_INPUT_KEY = "input";

export interface NamespacedName {
  namespace: string;
  name: string;
}

/** LM tool name for a function inside a `namespace` tool. */
export function namespacedToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

function decodeFunctionTool(raw: Rec, p: string): ToolDef {
  const name = str(raw.name, `${p}.name`);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
    throw badParam(
      `Invalid '${p}.name': must match ^[A-Za-z0-9_-]{1,128}$.`,
      `${p}.name`,
    );
  }
  const params = raw.parameters ?? { type: "object", properties: {} };
  if (!isRec(params)) {
    throw badParam(
      `Invalid type for '${p}.parameters': expected an object.`,
      `${p}.parameters`,
    );
  }
  const description = optStr(raw.description, `${p}.description`);
  return description !== undefined
    ? { name, description, inputSchema: params }
    : { name, inputSchema: params };
}

/**
 * Freeform tool (e.g. Codex apply_patch). The LM API only has JSON tools, so
 * the text travels in one string parameter; calls map back to
 * custom_tool_call items.
 */
function decodeCustomTool(raw: Rec, p: string): ToolDef {
  const name = str(raw.name, `${p}.name`);
  const fmt = isRec(raw.format) ? raw.format : undefined;
  const grammar =
    fmt?.type === "grammar" && typeof fmt.definition === "string"
      ? `Put the raw tool input in the "${CUSTOM_INPUT_KEY}" string. It must match this ${typeof fmt.syntax === "string" ? fmt.syntax : ""} grammar:\n${fmt.definition}`
      : `Put the raw tool input in the "${CUSTOM_INPUT_KEY}" string.`;
  const description = [optStr(raw.description, `${p}.description`), grammar]
    .filter(Boolean)
    .join("\n\n");
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { [CUSTOM_INPUT_KEY]: { type: "string" } },
      required: [CUSTOM_INPUT_KEY],
    },
  };
}

function decodeTools(tools: unknown): DecodedTools {
  const out: DecodedTools = {
    tools: [],
    hosted: [],
    namespaced: new Map(),
    custom: new Set(),
    toolSearch: false,
    dropped: [],
  };
  if (tools === undefined || tools === null) {
    return out;
  }
  if (!Array.isArray(tools)) {
    throw badParam("Invalid type for 'tools': expected an array.", "tools");
  }
  tools.forEach((raw, i) => {
    const p = `tools[${i}]`;
    if (!isRec(raw)) {
      throw badParam(`Invalid '${p}': expected an object.`, p);
    }
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type === "function") {
      out.tools.push(decodeFunctionTool(raw, p));
      return;
    }
    if (type === "namespace") {
      // Grouped tools (Codex sub-agents, MCP servers). The LM API has flat
      // names, so each becomes `<namespace>__<name>`; calls map back.
      const ns = str(raw.name, `${p}.name`);
      const inner = Array.isArray(raw.tools) ? raw.tools : [];
      const nsDesc = optStr(raw.description, `${p}.description`);
      inner.forEach((t, j) => {
        const q = `${p}.tools[${j}]`;
        if (!isRec(t) || (t.type !== "function" && t.type !== "custom")) {
          return;
        }
        const def =
          t.type === "custom"
            ? decodeCustomTool(t, q)
            : decodeFunctionTool(t, q);
        const flat = namespacedToolName(ns, def.name);
        out.namespaced.set(flat, { namespace: ns, name: def.name });
        if (t.type === "custom") {
          out.custom.add(flat);
        }
        const description = [nsDesc, def.description]
          .filter(Boolean)
          .join("\n\n");
        out.tools.push(
          description
            ? { ...def, name: flat, description }
            : { ...def, name: flat },
        );
      });
      return;
    }
    if (type === "custom") {
      const def = decodeCustomTool(raw, p);
      out.custom.add(def.name);
      out.tools.push(def);
      return;
    }
    if (RESPONSES_WEB_SEARCH_RE.test(type)) {
      const h = decodeHostedSearch(raw, type, p);
      if (h) {
        out.hosted.push(h);
      }
      return;
    }
    if (type === "tool_search") {
      // Client-executed tool search (Codex): offered as a function; calls map
      // back to tool_search_call items. Hosted (server) search is not
      // available through the LM API, so it is dropped.
      if (raw.execution !== "client") {
        out.dropped.push(type);
        return;
      }
      const params = isRec(raw.parameters)
        ? raw.parameters
        : { type: "object", properties: {} };
      const description = optStr(raw.description, `${p}.description`);
      out.toolSearch = true;
      out.tools.push(
        description !== undefined
          ? { name: TOOL_SEARCH_NAME, description, inputSchema: params }
          : { name: TOOL_SEARCH_NAME, inputSchema: params },
      );
      return;
    }
    // Other built-in tool types (file_search, code_interpreter, computer use,
    // image generation, mcp, ...) cannot run through the LM API. Dropping them
    // keeps the rest of the request working; the handler logs the names.
    out.dropped.push(type || "(missing type)");
  });
  return out;
}

function decodeToolChoice(
  v: unknown,
  tools: ToolDef[],
  hosted: HostedSearchTool[],
  hostedSearch: boolean,
): ToolMode {
  if (v === undefined || v === null || v === "auto") {
    return { kind: "auto" };
  }
  if (v === "none") {
    return { kind: "none" };
  }
  if (v === "required") {
    return { kind: "required" };
  }
  const known = (name: string, param: string): string => {
    if (!tools.some((t) => t.name === name)) {
      throw badParam(
        `Invalid '${param}': no function tool named '${name}'.`,
        param,
      );
    }
    return name;
  };
  if (isRec(v)) {
    if (v.type === "function") {
      return {
        kind: "required",
        only: [known(str(v.name, "tool_choice.name"), "tool_choice.name")],
      };
    }
    if (v.type === "allowed_tools") {
      const list = Array.isArray(v.tools) ? v.tools : [];
      const names = list.map((t, i) => {
        const p = `tool_choice.tools[${i}]`;
        if (!isRec(t) || t.type !== "function") {
          throw unsupported(`Only function tools may be listed in '${p}'.`, p);
        }
        return known(str(t.name, `${p}.name`), `${p}.name`);
      });
      if (v.mode === "required") {
        return { kind: "required", only: names };
      }
      if (v.mode === undefined || v.mode === "auto") {
        // Auto over a subset: the LM API cannot restrict without forcing, so
        // the full set is offered.
        return { kind: "auto" };
      }
      throw badParam(
        'Invalid \'tool_choice.mode\': expected "auto" or "required".',
        "tool_choice.mode",
      );
    }
    if (typeof v.type === "string" && RESPONSES_WEB_SEARCH_RE.test(v.type)) {
      if (!hostedSearch || !hosted.length) {
        // Forced hosted search that cannot run.
        throw new GatewayError(
          "tool_unavailable",
          `Hosted tool '${v.type}' is not available; configure a provider with the "Agent Gateway: Web Search and Fetch" command.`,
          { param: "tool_choice" },
        );
      }
      for (const h of hosted) {
        h.forced = true;
      }
      return { kind: "auto" };
    }
  }
  throw badParam(
    'Invalid \'tool_choice\': expected "auto", "none", "required", a function choice or allowed_tools.',
    "tool_choice",
  );
}

/** Responses request body -> CoreRequest (throws GatewayError, HTTP 400). */
export function decodeResponses(
  body: unknown,
  opts: DecodeOptions = {},
): ResponsesDecoded {
  if (!isRec(body)) {
    throw badParam("Request body must be a JSON object.", "body");
  }
  if (
    body.previous_response_id !== undefined &&
    body.previous_response_id !== null
  ) {
    throw unsupported(
      "previous_response_id is not supported; send the full conversation in 'input'.",
      "previous_response_id",
    );
  }
  if (body.conversation !== undefined && body.conversation !== null) {
    throw unsupported(
      "conversation is not supported; send the full conversation in 'input'.",
      "conversation",
    );
  }
  const hasInput =
    body.input !== undefined &&
    body.input !== null &&
    !(Array.isArray(body.input) && body.input.length === 0);
  const instructions = optStr(body.instructions, "instructions");
  if (!hasInput && !instructions) {
    throw badParam(
      "Either input or instructions is required",
      "input",
      "missing_required_parameter",
    );
  }
  const model = str(body.model, "model");
  if (!model) {
    throw badParam("Request body must specify a model.", "model");
  }

  const system: string[] = [];
  if (instructions) {
    system.push(instructions);
  }
  // Tools loaded by earlier client tool_search_output items become callable.
  const searchLoaded: unknown[] = [];
  const turns = decodeInput(body.input, system, opts.logger, searchLoaded);
  const decodedTools = decodeTools(
    searchLoaded.length
      ? [...(Array.isArray(body.tools) ? body.tools : []), ...searchLoaded]
      : body.tools,
  );
  if (decodedTools.dropped.length) {
    opts.logger?.info(
      `openai-responses dropped tool types the LM API cannot run: ${[...new Set(decodedTools.dropped)].join(", ")}`,
    );
  }
  // A loaded tool may repeat a declared one; the first definition wins.
  const seen = new Set<string>();
  const tools = decodedTools.tools.filter(
    (t) => !seen.has(t.name) && !!seen.add(t.name),
  );
  const hostedSearch = opts.hostedSearch === true;
  const toolMode = decodeToolChoice(
    body.tool_choice,
    tools,
    decodedTools.hosted,
    hostedSearch,
  );
  // Without a provider an optional hosted tool is dropped.
  const hosted = hostedSearch ? decodedTools.hosted : [];
  if (!hostedSearch && decodedTools.hosted.length) {
    opts.logger?.info(
      "openai-responses dropped web search: no web search engine is set (run Web Search and Fetch)",
    );
  }

  let reasoningEffort: string | undefined;
  let reasoningSummary: string | null = null;
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!isRec(body.reasoning)) {
      throw badParam(
        "Invalid type for 'reasoning': expected an object.",
        "reasoning",
      );
    }
    reasoningEffort = optStr(body.reasoning.effort, "reasoning.effort");
    reasoningSummary =
      optStr(body.reasoning.summary, "reasoning.summary") ?? null;
  }

  let includeEncryptedReasoning = false;
  if (body.include !== undefined && body.include !== null) {
    if (!Array.isArray(body.include)) {
      throw badParam(
        "Invalid type for 'include': expected an array.",
        "include",
      );
    }
    includeEncryptedReasoning = body.include.some(
      (x, i) => str(x, `include[${i}]`) === INCLUDE_ENCRYPTED_REASONING,
    );
  }

  const maxOutputTokens = optInt(body.max_output_tokens, "max_output_tokens");
  const maxToolCalls = optInt(body.max_tool_calls, "max_tool_calls");
  const parallelToolCalls = optBool(
    body.parallel_tool_calls,
    "parallel_tool_calls",
  );
  const temperature = optNum(body.temperature, "temperature");
  const topP = optNum(body.top_p, "top_p");
  const cacheKey = optStr(body.prompt_cache_key, "prompt_cache_key");
  const stream = optBool(body.stream, "stream") ?? false;
  optBool(body.store, "store");

  const echo: Record<string, unknown> = {
    instructions: instructions ?? null,
    max_output_tokens: maxOutputTokens ?? null,
    max_tool_calls: maxToolCalls ?? null,
    parallel_tool_calls: parallelToolCalls ?? true,
    reasoning: { effort: reasoningEffort ?? "none", summary: reasoningSummary },
    tool_choice: body.tool_choice ?? "auto",
    tools: Array.isArray(body.tools) ? body.tools : [],
    temperature: temperature ?? null,
    top_p: topP ?? null,
  };
  if (cacheKey !== undefined) {
    echo.prompt_cache_key = cacheKey;
  }

  const core: CoreRequest = {
    protocol: "openai-responses",
    model,
    echoModel: model,
    system,
    turns,
    tools,
    toolMode,
    hosted,
    stream,
    echo,
  };
  if (maxOutputTokens !== undefined) {
    core.maxOutputTokens = maxOutputTokens;
  }
  if (temperature !== undefined) {
    core.temperature = temperature;
  }
  if (topP !== undefined) {
    core.topP = topP;
  }
  if (reasoningEffort !== undefined) {
    core.reasoningEffort = reasoningEffort;
  }
  if (cacheKey !== undefined) {
    core.cacheKey = cacheKey;
  }
  if (parallelToolCalls !== undefined) {
    core.parallelToolCalls = parallelToolCalls;
  }
  if (maxToolCalls !== undefined) {
    core.maxToolCalls = maxToolCalls;
  }
  core.reasoningSummary = reasoningSummary;
  return {
    core,
    includeEncryptedReasoning,
    reasoningSummary,
    namespaced: decodedTools.namespaced,
    custom: decodedTools.custom,
    toolSearch: decodedTools.toolSearch,
  };
}
