import type { ClientPlan } from "./types";

/** Describe changed setting names, never their values or secret material. */
export function describeDifferences(plan: ClientPlan): string[] {
  const categories = new Set<string>();
  for (const change of plan.changes) {
    if (change.before === change.after) {
      continue;
    }
    const before = new Set(
      (change.before ?? "").split(/\r?\n/).map((line) => line.trim()),
    );
    const after = new Set(
      (change.after ?? "").split(/\r?\n/).map((line) => line.trim()),
    );
    const changed = [...before]
      .filter((line) => !after.has(line))
      .concat([...after].filter((line) => !before.has(line)));
    for (const line of changed) {
      const key = /^\s*["']?([\w.-]+)["']?\s*[:=]/
        .exec(line)?.[1]
        ?.toLowerCase();
      if (!key) {
        continue;
      }
      if (/api.?key|auth.?token|bearer/.test(key)) {
        categories.add("API key");
      } else if (/url|endpoint|baseurl/.test(key)) {
        categories.add("gateway URL");
      } else if (/context|output.?token|limit/.test(key)) {
        categories.add("model limits");
      } else if (
        /default.*model|^model$|anthropic_model|modelroles/.test(key)
      ) {
        categories.add("default model");
      } else if (/models|reasoning|modalit|tool.?call/.test(key)) {
        categories.add("model list or metadata");
      }
    }
  }
  return categories.size ? [...categories] : ["configuration files"];
}

/** Redact both old and new credential values in the diff, including short keys. */
export function redactConfigCredentials(text: string): string {
  return text.replace(
    /((?:["']?[\w.-]*(?:api[_-]?key|auth[_-]?token|bearer[_-]?token|authorization|password|secret|token)[\w.-]*["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,}\r\n]+)/gi,
    '$1"<redacted>"',
  );
}
