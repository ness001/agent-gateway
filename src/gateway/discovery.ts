import {
  ALL_OPERATIONS,
  ModelInfo,
  ProtocolOperation,
  ReasoningLevel,
} from "./types";

/** Structural subset of `vscode.LanguageModelChat` plus optional explicit metadata. */
export interface LanguageModelLike {
  id: string;
  name?: string;
  family?: string;
  version?: string;
  vendor?: string;
  maxInputTokens?: number;
  capabilities?: {
    supportsImageToText?: boolean;
    supportsToolCalling?: boolean;
  };
  configurationSchema?: unknown;
  [k: string]: unknown;
}

export class InvalidModelMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelMetadataError";
  }
}

const SHARED_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODALITIES = ["text", "image", "audio"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim() === "";

const isCleanEffort = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value === value.trim();

const has = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

interface ReasoningMetadata {
  defaultReasoningLevel: string;
  supportedReasoningLevels: ReasoningLevel[];
}

function getReasoningMetadata(
  model: Record<string, unknown>,
): ReasoningMetadata {
  // Explicit per-model metadata wins; an explicit empty list disables the picker.
  const hasLevels = has(model, "supported_reasoning_levels");
  let schema: Record<string, unknown> | undefined;
  let sharedFallback = false;
  let levels: ReasoningLevel[];
  if (hasLevels) {
    const raw = model.supported_reasoning_levels;
    if (!Array.isArray(raw)) {
      throw new InvalidModelMetadataError(
        "Model supported_reasoning_levels must be an array.",
      );
    }
    const seen = new Set<string>();
    levels = raw.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !isCleanEffort(entry.effort) ||
        seen.has(entry.effort)
      ) {
        throw new InvalidModelMetadataError(
          "Model reasoning levels must contain unique, valid effort values.",
        );
      }
      seen.add(entry.effort);
      return {
        effort: entry.effort,
        description: isBlank(entry.description)
          ? `${entry.effort} reasoning effort`
          : String(entry.description),
      };
    });
  } else {
    // VS Code providers describe selectable options with JSON Schema. Read the
    // values themselves, not model IDs, vendors, families, or UI labels.
    const config = model.configurationSchema;
    const props = isRecord(config) ? config.properties : undefined;
    const rawSchema = isRecord(props) ? props.reasoningEffort : undefined;
    if (rawSchema !== undefined && rawSchema !== null) {
      if (!isRecord(rawSchema) || !Array.isArray(rawSchema.enum)) {
        throw new InvalidModelMetadataError(
          "Model reasoningEffort schema must contain an enum array.",
        );
      }
      schema = rawSchema;
      const descriptions = Array.isArray(rawSchema.enumDescriptions)
        ? (rawSchema.enumDescriptions as unknown[])
        : undefined;
      const labels = Array.isArray(rawSchema.enumItemLabels)
        ? (rawSchema.enumItemLabels as unknown[])
        : undefined;
      const seen = new Set<string>();
      levels = (rawSchema.enum as unknown[]).map((effort, index) => {
        if (!isCleanEffort(effort) || seen.has(effort)) {
          throw new InvalidModelMetadataError(
            "Model reasoning enum must contain unique, nonempty strings.",
          );
        }
        seen.add(effort);
        let description = `${effort} reasoning effort`;
        if (
          descriptions &&
          index < descriptions.length &&
          !isBlank(descriptions[index])
        ) {
          description = String(descriptions[index]);
        } else if (labels && index < labels.length && !isBlank(labels[index])) {
          description = String(labels[index]);
        }
        return { effort, description };
      });
    } else {
      // Compatibility policy, not discovered capability: one shared menu.
      sharedFallback = true;
      levels = SHARED_FALLBACK_EFFORTS.map((effort) => ({
        effort,
        description: `${effort} reasoning requested; upstream support is not advertised`,
      }));
    }
  }
  // Medium matches the shared menu default; this never rewrites request bodies.
  let defaultLevel =
    !sharedFallback && levels.length > 0 ? levels[0].effort : "medium";
  let declared: { value: unknown } | undefined;
  if (has(model, "default_reasoning_level")) {
    declared = { value: model.default_reasoning_level };
  } else if (!hasLevels && schema && has(schema, "default")) {
    declared = { value: schema.default };
  }
  if (declared) {
    const value = declared.value;
    if (
      !isCleanEffort(value) ||
      (levels.length > 0 && !levels.some((l) => l.effort === value))
    ) {
      throw new InvalidModelMetadataError(
        "Model default_reasoning_level must be a supported effort.",
      );
    }
    defaultLevel = value;
  }
  return {
    defaultReasoningLevel: defaultLevel,
    supportedReasoningLevels: levels,
  };
}

interface InputMetadata {
  contextWindow: number | null;
  inputModalities: string[];
  supportsToolCalling: boolean | null;
}

function getInputMetadata(model: Record<string, unknown>): InputMetadata {
  // Unknown capacity is not a 1M-token guarantee. Explicit metadata wins.
  let contextWindow: number | null = null;
  for (const name of ["context_window", "maxInputTokens"]) {
    const value = model[name];
    if (value !== undefined && value !== null) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        throw new InvalidModelMetadataError(
          "Model context window must be a positive integer.",
        );
      }
      contextWindow = value;
      break;
    }
  }
  let inputModalities = ["text"];
  const capabilities = isRecord(model.capabilities)
    ? model.capabilities
    : undefined;
  if (has(model, "input_modalities")) {
    const raw = model.input_modalities;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new InvalidModelMetadataError(
        "Model input_modalities must be a nonempty array.",
      );
    }
    const seen = new Set<string>();
    for (const m of raw as unknown[]) {
      if (typeof m !== "string" || !MODALITIES.includes(m) || seen.has(m)) {
        throw new InvalidModelMetadataError(
          "Model input modalities must contain unique, valid values.",
        );
      }
      seen.add(m);
    }
    inputModalities = [...(raw as string[])];
  } else if (capabilities?.supportsImageToText === true) {
    inputModalities = ["text", "image"];
  }
  let supportsToolCalling: boolean | null = null;
  if (capabilities && has(capabilities, "supportsToolCalling")) {
    if (typeof capabilities.supportsToolCalling !== "boolean") {
      throw new InvalidModelMetadataError(
        "Model supportsToolCalling must be a boolean.",
      );
    }
    supportsToolCalling = capabilities.supportsToolCalling;
  } else if (has(model, "supportsToolCalling")) {
    const value = model.supportsToolCalling;
    if (value !== null && value !== undefined && typeof value !== "boolean") {
      throw new InvalidModelMetadataError(
        "Model supportsToolCalling must be a boolean.",
      );
    }
    supportsToolCalling = (value as boolean | null | undefined) ?? null;
  }
  return { contextWindow, inputModalities, supportsToolCalling };
}

/** Normalises a local VS Code chat model; local models support every operation. */
export function toModelInfo(model: LanguageModelLike): ModelInfo {
  if (
    !isRecord(model) ||
    typeof model.id !== "string" ||
    model.id.trim() === ""
  ) {
    throw new InvalidModelMetadataError(
      "Discovery returned an invalid model ID.",
    );
  }
  const record = model as Record<string, unknown>;
  const reasoning = getReasoningMetadata(record);
  const input = getInputMetadata(record);
  const info: ModelInfo = {
    id: model.id,
    displayName: isBlank(model.name) ? model.id : String(model.name),
    contextWindow: input.contextWindow,
    inputModalities: input.inputModalities,
    supportsToolCalling: input.supportsToolCalling,
    defaultReasoningLevel: reasoning.defaultReasoningLevel,
    supportedReasoningLevels: reasoning.supportedReasoningLevels,
    operations: [...ALL_OPERATIONS],
  };
  if (typeof model.family === "string") {
    info.family = model.family;
  }
  if (typeof model.version === "string") {
    info.version = model.version;
  }
  if (typeof model.vendor === "string") {
    info.vendor = model.vendor;
  }
  return info;
}

/**
 * VS Code can report one ID under several vendors; the inference contract
 * accepts only an ID, so the first occurrence wins.
 */
export function dedupeModels<T extends { id: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.id)) {
      return false;
    }
    seen.add(m.id);
    return true;
  });
}

function invalid(field: string): never {
  throw new InvalidModelMetadataError(
    `Catalogue model has an invalid ${field}.`,
  );
}

/** Strictly validates one remote catalogue model and returns a clean copy. */
export function validateModelInfo(value: unknown): ModelInfo {
  if (!isRecord(value)) {
    return invalid("record");
  }
  const v = value;
  if (typeof v.id !== "string" || v.id.trim() === "") {
    invalid("id");
  }
  if (typeof v.displayName !== "string" || v.displayName.trim() === "") {
    invalid("displayName");
  }
  for (const key of ["family", "version", "vendor"]) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      invalid(key);
    }
  }
  if (
    v.contextWindow !== null &&
    (typeof v.contextWindow !== "number" ||
      !Number.isSafeInteger(v.contextWindow) ||
      v.contextWindow <= 0)
  ) {
    invalid("contextWindow");
  }
  const modalities = v.inputModalities;
  if (
    !Array.isArray(modalities) ||
    modalities.length === 0 ||
    new Set(modalities).size !== modalities.length ||
    modalities.some((m) => typeof m !== "string" || !MODALITIES.includes(m))
  ) {
    invalid("inputModalities");
  }
  if (
    v.supportsToolCalling !== null &&
    typeof v.supportsToolCalling !== "boolean"
  ) {
    invalid("supportsToolCalling");
  }
  if (!Array.isArray(v.supportedReasoningLevels)) {
    invalid("supportedReasoningLevels");
  }
  const seen = new Set<string>();
  const levels = (v.supportedReasoningLevels as unknown[]).map((l) => {
    if (
      !isRecord(l) ||
      !isCleanEffort(l.effort) ||
      seen.has(l.effort) ||
      typeof l.description !== "string"
    ) {
      return invalid("supportedReasoningLevels");
    }
    seen.add(l.effort);
    return { effort: l.effort, description: l.description };
  });
  if (
    !isCleanEffort(v.defaultReasoningLevel) ||
    (levels.length > 0 && !seen.has(v.defaultReasoningLevel))
  ) {
    invalid("defaultReasoningLevel");
  }
  const ops = v.operations;
  if (
    !Array.isArray(ops) ||
    new Set(ops).size !== ops.length ||
    ops.some((o) => !ALL_OPERATIONS.includes(o as ProtocolOperation))
  ) {
    invalid("operations");
  }
  const info: ModelInfo = {
    id: v.id as string,
    displayName: v.displayName as string,
    contextWindow: v.contextWindow as number | null,
    inputModalities: [...(modalities as string[])],
    supportsToolCalling: v.supportsToolCalling as boolean | null,
    defaultReasoningLevel: v.defaultReasoningLevel as string,
    supportedReasoningLevels: levels,
    operations: [...(ops as ProtocolOperation[])],
  };
  if (typeof v.family === "string") {
    info.family = v.family;
  }
  if (typeof v.version === "string") {
    info.version = v.version;
  }
  if (typeof v.vendor === "string") {
    info.vendor = v.vendor;
  }
  return info;
}
