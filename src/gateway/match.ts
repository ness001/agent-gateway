import type { CatalogEntry, ProtocolOperation, RemoteState } from "./types";

export const ASTRA_FALLBACK_IDS = [
  "gpt-6-astra",
  "gateway-claude-gpt-6-astra",
  "gpt-6-astra[1m]",
  "gateway-claude-gpt-6-astra[1m]",
];

const isBlank = (s: string): boolean => s.trim() === "";

/**
 * Matches the first candidate ID that exists. Duplicate IDs resolve to
 * undefined so ambiguity is never hidden (mirrors `$route.Count -ne 1`).
 */
function firstPresent<T extends { id: string }>(
  reg: T[],
  ids: string[],
): T | undefined | null {
  for (const id of ids) {
    const found = reg.filter((e) => e.id === id);
    if (found.length > 0) {
      return found.length === 1 ? found[0] : null;
    }
  }
  return undefined;
}

// Mirrors the remote-name rule in remoteConfig.ts.
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const sanitizeReason = (s: string): string =>
  s
    .replace(/[^ -~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * Explains why a model ID has no route. A "<name>--" prefix is attributed to
 * the matching remote so a missing remote model is not reported as merely
 * unknown.
 */
export function explainUnknownModel(
  model: string,
  remotes: RemoteState[] = [],
): string {
  const owner = remotes
    .filter((r) => model.startsWith(`${r.name}--`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (owner) {
    const id = model.slice(owner.name.length + 2);
    return owner.status === "ready"
      ? `remote '${owner.name}' does not advertise model '${id}'`
      : `remote '${owner.name}' is unavailable (${sanitizeReason(owner.reason)})`;
  }
  const sep = model.indexOf("--");
  if (sep > 0 && REMOTE_NAME_PATTERN.test(model.slice(0, sep))) {
    return `remote '${model.slice(0, sep)}' is not configured`;
  }
  return "unknown model";
}

export interface ResolvedModel {
  entry: CatalogEntry;
  fallback: boolean;
  /** Set only when `fallback` is true. */
  reason?: string;
}

export interface FallbackOptions {
  /** `agentGateway.fallbackModel`; empty uses the default. */
  fallbackModel?: string;
  /** Only models serving this operation are chosen when set. */
  operation?: ProtocolOperation;
  /** Called when `fallbackModel` names no usable local model. */
  onMissingFallback?: (id: string) => void;
}

type FallbackCandidate = Pick<CatalogEntry, "id" | "remote"> & {
  operations?: ProtocolOperation[];
};

export interface FallbackChoice<T extends FallbackCandidate = CatalogEntry> {
  entry: T;
  source: "setting" | "default";
}

/**
 * The unknown-model fallback: `agentGateway.fallbackModel` when it names a
 * local model, else `gpt-6-astra`, else none. Remote models are never chosen.
 */
export function resolveFallbackModel<T extends FallbackCandidate>(
  reg: T[],
  opts: FallbackOptions = {},
): FallbackChoice<T> | undefined {
  const local = reg.filter(
    (e) =>
      e.remote === undefined &&
      (opts.operation === undefined ||
        (e.operations ?? []).includes(opts.operation)),
  );
  const configured = opts.fallbackModel?.trim();
  if (configured) {
    const ids = configured.endsWith("[1m]")
      ? [configured]
      : [configured, configured + "[1m]"];
    const found = firstPresent(local, ids);
    if (found) {
      return { entry: found, source: "setting" };
    }
    opts.onMissingFallback?.(configured);
  }
  const astra = firstPresent(local, ASTRA_FALLBACK_IDS);
  return astra ? { entry: astra, source: "default" } : undefined;
}

export function resolveModel(
  reg: CatalogEntry[],
  model: string,
  opts: { allowFallback: boolean; remotes?: RemoteState[] } & FallbackOptions,
): ResolvedModel | undefined {
  const candidates = [model];
  // The "[1m]" suffix is accepted only when that exact route exists.
  if (!isBlank(model) && !model.endsWith("[1m]")) {
    candidates.push(model + "[1m]");
  }
  const direct = firstPresent(reg, candidates);
  if (direct) {
    return { entry: direct, fallback: false };
  }
  if (direct === null || !opts.allowFallback || isBlank(model)) {
    return undefined;
  }
  const fallback = resolveFallbackModel(reg, opts)?.entry;
  return fallback
    ? {
        entry: fallback,
        fallback: true,
        reason: explainUnknownModel(model, opts.remotes),
      }
    : undefined;
}

export function isValidGeminiModelSegment(s: string): boolean {
  return (
    typeof s === "string" &&
    !isBlank(s) &&
    !/[\s\p{C}/\\:%?#]/u.test(s) &&
    s !== "." &&
    s !== ".."
  );
}

/** Built-in aliases for internal model names used by Gemini CLI and Antigravity CLI. */
export const DEFAULT_MODEL_ALIASES: Readonly<Record<string, "flash" | "pro">> =
  {
    "gemini-3-flash-preview": "flash",
    "gemini-2.5-flash": "flash",
    "gemini-2.5-flash-lite": "flash",
    "gemini-3.1-flash-lite-preview": "flash",
    "gemini-3-pro-preview": "pro",
    "gemini-2.5-pro": "pro",
  };

const GEMINI_FAMILY = /gemini/i;

const versionKey = (id: string): number[] =>
  (id.match(/\d+(?:\.\d+)*/g) ?? []).flatMap((n) => n.split(".").map(Number));

const compareVersions = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
};

/**
 * Highest-version local, non-alias Gemini-family model of a tier that serves
 * the operation. Ties prefer the shorter, then lexicographically smaller ID.
 */
export function bestLocalGeminiModel(
  reg: CatalogEntry[],
  tier: "flash" | "pro",
  operation: ProtocolOperation,
): CatalogEntry | undefined {
  const tierPattern = tier === "flash" ? /flash/i : /(^|[^a-z])pro([^a-z]|$)/i;
  return reg
    .filter(
      (e) =>
        e.remote === undefined &&
        !e.isAlias &&
        e.operations.includes(operation) &&
        GEMINI_FAMILY.test(`${e.family ?? ""} ${e.id}`) &&
        tierPattern.test(e.id),
    )
    .sort(
      (a, b) =>
        compareVersions(versionKey(b.id), versionKey(a.id)) ||
        a.id.length - b.id.length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
}

export interface AliasOptions {
  /** `agentGateway.modelAliases`; an empty value disables a default. */
  userAliases?: Readonly<Record<string, unknown>>;
  /** `agentGateway.webSearch.model`, used for search side requests. */
  searchModel?: string;
  /** True for a Gemini request whose only tools are hosted search. */
  hostedSearch?: boolean;
  operation: ProtocolOperation;
  /** `agentGateway.fallbackModel`, the last resort for built-in aliases. */
  fallbackModel?: string;
  onMissingFallback?: (id: string) => void;
}

/**
 * Resolves a requested model that has no route through the model aliases.
 * Order: user alias (exact target; empty disables), the configured search
 * model for hosted-search side requests, then the built-in Gemini CLI names
 * (best local Gemini Flash/Pro, else the fallback model). Remote models are
 * never chosen; targets that do not serve the operation are skipped.
 */
export function resolveModelAlias(
  reg: CatalogEntry[],
  model: string,
  opts: AliasOptions,
): CatalogEntry | undefined {
  const serves = (e: CatalogEntry | undefined) =>
    e && e.remote === undefined && e.operations.includes(opts.operation)
      ? e
      : undefined;
  const user = opts.userAliases;
  if (user && Object.prototype.hasOwnProperty.call(user, model)) {
    const target = user[model];
    if (typeof target !== "string" || target.trim() === "") {
      return undefined;
    }
    return serves(
      resolveModel(reg, target.trim(), { allowFallback: false })?.entry,
    );
  }
  const tier = DEFAULT_MODEL_ALIASES[model];
  if (!tier && !opts.hostedSearch) {
    return undefined;
  }
  const configured = opts.hostedSearch ? opts.searchModel?.trim() : undefined;
  if (configured) {
    const found = serves(
      resolveModel(reg, configured, { allowFallback: false })?.entry,
    );
    if (found) {
      return found;
    }
  }
  const best =
    bestLocalGeminiModel(reg, tier ?? "flash", opts.operation) ??
    // Search side requests take any local Gemini model; plain aliases keep their tier.
    (tier && !opts.hostedSearch
      ? undefined
      : bestLocalGeminiModel(
          reg,
          tier === "pro" ? "flash" : "pro",
          opts.operation,
        ));
  if (best) {
    return best;
  }
  return resolveFallbackModel(reg, opts)?.entry;
}
