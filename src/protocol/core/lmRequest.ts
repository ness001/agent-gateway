import { normalizeImageBytes } from "./images";
import type {
  CoreRequest,
  ImagePart,
  Part,
  TextPart,
  ToolDef,
  ToolMode,
} from "./types";

/**
 * `modelOptions` key carrying the prompt-cache conversation id. The exact key
 * Copilot honours is not documented, so it lives in this one constant and can
 * be overridden per call via `BuildOptions.cacheKeyOption`.
 */
export const CACHE_ID_OPTION_KEY = "conversationId";

/** `modelOptions` key for reasoning effort. */
export const REASONING_EFFORT_OPTION_KEY = "reasoningEffort";

/** `modelOptions` key for the output limit. */
export const MAX_TOKENS_OPTION_KEY = "max_tokens";

/** Fixed justification string. */
export const LM_JUSTIFICATION =
  "Agent Gateway forwards a request from a local coding agent.";

/** Structural subset of the `vscode` namespace needed to build requests. */
export interface LmApi {
  LanguageModelChatMessage: {
    User(content: unknown[], name?: string): unknown;
    Assistant(content: unknown[], name?: string): unknown;
  };
  LanguageModelTextPart: new (value: string) => unknown;
  LanguageModelToolCallPart: new (
    callId: string,
    name: string,
    input: object,
  ) => unknown;
  LanguageModelToolResultPart: new (
    callId: string,
    content: unknown[],
  ) => unknown;
  LanguageModelDataPart: { image(data: Uint8Array, mime: string): unknown };
  /** Proposed API; present only when the host exposes it. */
  LanguageModelThinkingPart?: new (
    value: string,
    id?: string,
    metadata?: Record<string, unknown>,
  ) => unknown;
  LanguageModelChatToolMode: {
    readonly Auto: number;
    readonly Required: number;
  };
}

/** Effort levels advertised by discovery (subset of gateway `ModelInfo`). */
export interface EffortInfo {
  supportedReasoningLevels: ReadonlyArray<{ effort: string }>;
}

export interface BuildOptions {
  /** Model metadata, e.g. `toModelInfo(model)` from gateway/discovery.ts. */
  model?: EffortInfo;
  /** Override of {@link CACHE_ID_OPTION_KEY}. */
  cacheKeyOption?: string;
}

export interface LmToolLike {
  name: string;
  description: string;
  inputSchema?: object;
}

export interface LmRequestOptions {
  justification: string;
  modelOptions: Record<string, unknown>;
  tools?: LmToolLike[];
  toolMode?: number;
}

export interface LmRequest {
  messages: unknown[];
  options: LmRequestOptions;
}

function imagePart(api: LmApi, p: ImagePart): unknown {
  const img = normalizeImageBytes(p.data, { declaredMime: p.mime });
  return api.LanguageModelDataPart.image(img.bytes, img.mime);
}

function resultContent(
  api: LmApi,
  content: Array<TextPart | ImagePart>,
): unknown[] {
  const out = content.map((c) =>
    c.type === "text"
      ? new api.LanguageModelTextPart(c.text)
      : imagePart(api, c),
  );
  return out.length > 0 ? out : [new api.LanguageModelTextPart("")];
}

function convertPart(api: LmApi, p: Part): unknown {
  switch (p.type) {
    case "text":
      return new api.LanguageModelTextPart(p.text);
    case "image":
      return imagePart(api, p);
    case "toolCall":
      return new api.LanguageModelToolCallPart(p.id, p.name, p.input);
    case "toolResult":
      return new api.LanguageModelToolResultPart(
        p.callId,
        resultContent(api, p.content),
      );
    case "thinking":
      // Replayed only when the host has the proposed thinking part; else dropped.
      if (!api.LanguageModelThinkingPart) {
        return undefined;
      }
      return new api.LanguageModelThinkingPart(
        p.text,
        undefined,
        p.signature !== undefined ? { signature: p.signature } : undefined,
      );
  }
}

/**
 * Builds messages. The LM API has only User and Assistant roles,
 * so system/developer text is folded into one leading User
 * message, joined by blank lines.
 */
export function toLmMessages(
  api: LmApi,
  req: Pick<CoreRequest, "system" | "turns">,
): unknown[] {
  const messages: unknown[] = [];
  const system = req.system.filter((s) => s.length > 0).join("\n\n");
  if (system) {
    messages.push(
      api.LanguageModelChatMessage.User([
        new api.LanguageModelTextPart(system),
      ]),
    );
  }
  for (const turn of req.turns) {
    const parts: unknown[] = [];
    for (const p of turn.parts) {
      const c = convertPart(api, p);
      if (c !== undefined) {
        parts.push(c);
      }
    }
    if (parts.length === 0) {
      continue;
    }
    messages.push(
      turn.role === "assistant"
        ? api.LanguageModelChatMessage.Assistant(parts)
        : api.LanguageModelChatMessage.User(parts),
    );
  }
  return messages;
}

export function toLmTool(t: ToolDef): LmToolLike {
  return {
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  };
}

/**
 * ToolMode table: auto -> Auto; none -> no tools;
 * required -> Required; required with `only` -> Required with only those tools.
 */
export function mapTools(
  api: LmApi,
  tools: readonly ToolDef[],
  mode: ToolMode,
): { tools?: LmToolLike[]; toolMode?: number } {
  if (mode.kind === "none" || tools.length === 0) {
    return {};
  }
  if (mode.kind === "auto") {
    return {
      tools: tools.map(toLmTool),
      toolMode: api.LanguageModelChatToolMode.Auto,
    };
  }
  const allowed =
    mode.only && mode.only.length > 0 ? new Set(mode.only) : undefined;
  const picked = allowed ? tools.filter((t) => allowed.has(t.name)) : tools;
  if (picked.length === 0) {
    return {};
  }
  return {
    tools: picked.map(toLmTool),
    toolMode: api.LanguageModelChatToolMode.Required,
  };
}

/** True when `effort` is in the model's advertised enum. */
export function effortSupported(
  model: EffortInfo | undefined,
  effort: string,
): boolean {
  return !!model?.supportedReasoningLevels.some((l) => l.effort === effort);
}

export function buildModelOptions(
  req: Pick<CoreRequest, "reasoningEffort" | "cacheKey" | "maxOutputTokens">,
  opts: BuildOptions = {},
): Record<string, unknown> {
  const mo: Record<string, unknown> = {};
  if (
    req.reasoningEffort !== undefined &&
    effortSupported(opts.model, req.reasoningEffort)
  ) {
    mo[REASONING_EFFORT_OPTION_KEY] = req.reasoningEffort;
  }
  if (req.cacheKey) {
    mo[opts.cacheKeyOption ?? CACHE_ID_OPTION_KEY] = req.cacheKey;
  }
  if (req.maxOutputTokens !== undefined) {
    mo[MAX_TOKENS_OPTION_KEY] = req.maxOutputTokens;
  }
  return mo;
}

/** CoreRequest -> messages + LanguageModelChatRequestOptions-shaped object. */
export function buildLmRequest(
  api: LmApi,
  req: CoreRequest,
  opts: BuildOptions = {},
): LmRequest {
  const options: LmRequestOptions = {
    justification: LM_JUSTIFICATION,
    modelOptions: buildModelOptions(req, opts),
    ...mapTools(api, req.tools, req.toolMode),
  };
  return { messages: toLmMessages(api, req), options };
}
