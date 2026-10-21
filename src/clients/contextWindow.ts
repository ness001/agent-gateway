import { ALIAS_PREFIX } from "../gateway/catalog";
import type { ClientConfigInput } from "./types";

/** Accept only usable token capacities from metadata. */
export function validContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Look up advertised input capacity, never infer it from a model name. */
export function selectedContextWindow(
  input: ClientConfigInput,
): number | undefined {
  const id = input.defaultModel;
  const native = id.startsWith(ALIAS_PREFIX)
    ? id.slice(ALIAS_PREFIX.length)
    : id;
  const model =
    input.models.find((m) => m.id === id) ??
    input.models.find((m) => m.id === native) ??
    input.models.find((m) => m.id === native.replace(/\[\d+[mk]\]$/i, ""));
  return validContextWindow(model?.contextWindow);
}
