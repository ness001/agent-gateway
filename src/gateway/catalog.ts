import { resolveFallbackModel } from "./match";
import {
  CatalogEntry,
  GATEWAY_CATALOG_VERSION,
  GatewayCatalogResponse,
  ModelInfo,
} from "./types";

export const MODEL_CREATED_AT = "2026-08-14T00:00:00Z";
export const ALIAS_PREFIX = "gateway-claude-";

const CODEX_BASE_INSTRUCTIONS =
  "You are a coding assistant. Follow the user request and repository instructions. Inspect relevant code before editing, preserve unrelated changes, validate your work with focused tests, and clearly report results and limitations. Use the available tools when needed and respect approval and sandbox restrictions.";

const cloneInfo = (m: ModelInfo): ModelInfo => ({
  ...m,
  inputModalities: [...m.inputModalities],
  supportedReasoningLevels: m.supportedReasoningLevels.map((l) => ({ ...l })),
  operations: [...m.operations],
});

/** Local IDs first, then remotes in order; earlier wins; then one alias per native entry. */
export function buildRegistry(
  local: ModelInfo[],
  remotes: { name: string; models: ModelInfo[] }[],
): CatalogEntry[] {
  const candidates: CatalogEntry[] = [
    ...local.map((m) => ({
      ...cloneInfo(m),
      upstreamModelId: m.id,
      isAlias: false,
    })),
    ...remotes.flatMap((r) =>
      r.models.map((m) => ({
        ...cloneInfo(m),
        id: `${r.name}--${m.id}`,
        displayName: `[${r.name}] ${m.displayName}`,
        upstreamModelId: m.id,
        remote: r.name,
        isAlias: false,
      })),
    ),
  ];
  const ids = new Set<string>();
  const registry: CatalogEntry[] = [];
  for (const entry of candidates) {
    if (!ids.has(entry.id)) {
      ids.add(entry.id);
      registry.push(entry);
    }
  }
  for (const entry of [...registry]) {
    const aliasId = ALIAS_PREFIX + entry.id;
    if (!ids.has(aliasId)) {
      ids.add(aliasId);
      registry.push({
        ...entry,
        ...cloneInfo(entry),
        id: aliasId,
        isAlias: true,
      });
    }
  }
  return registry;
}

export interface ModelsResponse {
  data: {
    type: "model";
    id: string;
    display_name: string;
    created_at: string;
    /** OpenAI-compatible extras for auto-discovering clients. */
    object: "model";
    owned_by: string;
    context_length?: number;
    context_window?: number;
  }[];
  object: "list";
  has_more: false;
  first_id: string | null;
  last_id: string | null;
}

export function createModelsResponse(reg: CatalogEntry[]): ModelsResponse {
  const data = reg.map((e) => ({
    type: "model" as const,
    id: e.id,
    display_name: e.displayName,
    created_at: MODEL_CREATED_AT,
    object: "model" as const,
    owned_by: e.remote ?? "copilot",
    ...(e.contextWindow !== null
      ? { context_length: e.contextWindow, context_window: e.contextWindow }
      : {}),
  }));
  return {
    object: "list",
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

export interface CodexModel {
  slug: string;
  display_name: string;
  description: null;
  base_instructions: string;
  default_reasoning_level: string;
  supported_reasoning_levels: { effort: string; description: string }[];
  shell_type: "shell_command";
  visibility: "list";
  supported_in_api: true;
  priority: number;
  upgrade: null;
  support_verbosity: false;
  default_verbosity: null;
  apply_patch_tool_type: null;
  truncation_policy: { mode: "bytes"; limit: number };
  supports_image_detail_original: false;
  input_modalities: string[];
  context_window: number | null;
  max_context_window: number | null;
  experimental_supported_tools: never[];
}

export function createCodexModelsResponse(reg: CatalogEntry[]): {
  models: CodexModel[];
} {
  // Codex gets native models only: no Claude aliases or internal utility models.
  const filtered = reg.filter(
    (e) =>
      !e.isAlias &&
      !e.upstreamModelId.startsWith("copilot-utility") &&
      !e.upstreamModelId.startsWith("copilot-dictation") &&
      e.supportsToolCalling !== false &&
      e.operations.includes("openai.responses"),
  );
  return {
    models: filtered.map((e, priority) => ({
      slug: e.id,
      display_name: e.displayName,
      description: null,
      base_instructions: CODEX_BASE_INSTRUCTIONS,
      default_reasoning_level: e.defaultReasoningLevel,
      supported_reasoning_levels: e.supportedReasoningLevels.map((l) => ({
        effort: l.effort,
        description: l.description,
      })),
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority,
      upgrade: null,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_image_detail_original: false,
      input_modalities: [...e.inputModalities],
      context_window: e.contextWindow,
      max_context_window: e.contextWindow,
      experimental_supported_tools: [],
    })),
  };
}

/** Only local models are exported, which prevents forwarding loops and chains. */
export function createGatewayCatalog(
  local: ModelInfo[],
): GatewayCatalogResponse {
  return {
    version: GATEWAY_CATALOG_VERSION as 1,
    models: local.map(cloneInfo),
  };
}

const FAMILY_GROUPS: [string, RegExp][] = [
  ["GPT", /^gpt-/i],
  ["Claude", /^claude-/i],
  ["Gemini", /^gemini-/i],
  ["Grok", /^grok-/i],
];

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type SummaryEntry = Pick<CatalogEntry, "id" | "upstreamModelId"> &
  Partial<Pick<CatalogEntry, "isAlias" | "remote">>;

/** Startup summary grouped by upstream model family; IDs are JSON-escaped. */
export function summarizeModels(
  reg: SummaryEntry[],
  fallbackModel?: string,
): string[] {
  const groups = new Map<string, SummaryEntry[]>(
    ["GPT", "Claude", "Gemini", "Grok", "Other", "Aliases"].map((n) => [n, []]),
  );
  for (const entry of reg) {
    const name = entry.isAlias
      ? "Aliases"
      : (FAMILY_GROUPS.find(([, re]) => re.test(entry.upstreamModelId))?.[0] ??
        "Other");
    groups.get(name)!.push(entry);
  }
  const aliasCount = groups.get("Aliases")!.length;
  const lines = [
    `Available models: ${reg.length - aliasCount} model IDs, ${aliasCount} aliases`,
  ];
  for (const [name, entries] of groups) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`${name} (${entries.length}):`);
    for (const e of [...entries].sort((a, b) => ordinal(a.id, b.id))) {
      // Escape untrusted IDs to prevent terminal/log control injection.
      lines.push(
        name === "Aliases"
          ? `  ${JSON.stringify(e.id)} -> ${JSON.stringify(e.upstreamModelId)}`
          : `  ${JSON.stringify(e.id)}`,
      );
    }
  }
  let missing: string | undefined;
  const fallback = resolveFallbackModel(reg, {
    fallbackModel,
    onMissingFallback: (id) => (missing = id),
  })?.entry;
  if (missing !== undefined) {
    lines.push(
      `agentGateway.fallbackModel ${JSON.stringify(missing)} is not an available local model; using the default fallback.`,
    );
  }
  lines.push(
    fallback
      ? `Unknown-model fallback (non-Gemini): ${JSON.stringify(fallback.upstreamModelId)}`
      : "Unknown-model fallback: unavailable",
  );
  return lines;
}
