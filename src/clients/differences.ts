import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

import type { ClientPlan } from "./types";

const restoration = /^(?:AGENT_GATEWAY_PREVIOUS|updatedAt|agentGateway)$/i;
const credential =
  /api[_-]?key|auth[_-]?token|bearer[_-]?token|authorization|password|secret|token$/i;

function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, value.length);
    value.forEach((child, index) => flatten(child, `${prefix}.${index}`, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!restoration.test(key)) {
        flatten(child, prefix ? `${prefix}.${key}` : key, out);
      }
    }
  } else {
    out.set(prefix, value);
  }
}

/** Parse supported configuration formats; comments and restore records are not settings. */
function values(path: string, text: string | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (
    text === undefined ||
    /(?:agent-gateway-default|agent-gateway)\.json$/i.test(path)
  ) {
    return out;
  }
  if (/\.jsonc?$/i.test(path)) {
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text, errors, {
      allowTrailingComma: true,
    });
    if (errors.length) {
      throw new Error("Configuration is not valid JSON with comments.");
    }
    flatten(parsed, "", out);
    return out;
  }
  if (/\.ya?ml$/i.test(path)) {
    const doc = parseDocument(text);
    if (doc.errors.length) {
      throw new Error("Configuration is not valid YAML.");
    }
    flatten(doc.toJS(), "", out);
    return out;
  }
  // TOML and env adapters use scalar assignments; sort by section/key rather than line order.
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|\/\/|$)/.test(line)) {
      continue;
    }
    const table = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      section = table[1];
      continue;
    }
    const assignment = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!assignment) {
      out.set(`raw:${line.trim()}`, true);
      continue;
    }
    // A # inside a quoted URL/token is data, not a trailing TOML/env comment.
    let raw = assignment[2];
    let quote = "";
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) {
          quote = "";
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "#") {
        raw = raw.slice(0, i).trim();
        break;
      }
    }
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.replace(/^'|'$/g, "");
    }
    out.set(section ? `${section}.${assignment[1]}` : assignment[1], value);
  }
  return out;
}

export function settingDifferences(plan: ClientPlan): string[] {
  const keys = new Set<string>();
  for (const change of plan.changes) {
    if (change.before === change.after) {
      continue;
    }
    const before = values(change.path, change.before);
    const after = values(change.path, change.after);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (!isDeepStrictEqual(before.get(key), after.get(key))) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/** Names only: never return configuration values or credentials. */
export function describeDifferences(plan: ClientPlan): string[] {
  const categories = new Set<string>();
  for (const path of settingDifferences(plan)) {
    const key = path.split(".").at(-1)!.toLowerCase();
    if (credential.test(key)) {
      categories.add("API key");
    } else if (/url|endpoint/.test(key)) {
      categories.add("gateway URL");
    } else if (/context|output.?token|limit/.test(key)) {
      categories.add("model limits");
    } else if (
      /default.*model|^model$|anthropic_model|modelroles|primary|model_provider|defaultprovider/.test(
        key,
      )
    ) {
      categories.add("default model");
    } else if (/models|reasoning|modalit|tool.?call/.test(path.toLowerCase())) {
      categories.add("model list or metadata");
    } else {
      categories.add(
        path.startsWith("raw:") ? "configuration files" : `setting ${path}`,
      );
    }
  }
  return [...categories];
}

function redactAssignments(text: string): string {
  return text.replace(
    /((?:["']?[\w.-]*(?:api[_-]?key|auth[_-]?token|bearer[_-]?token|authorization|password|secret|token)[\w.-]*["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,}\r\n]+)/gi,
    '$1"<redacted>"',
  );
}

/** Redact nested objects and JSON-encoded restoration snapshots, then non-JSON assignments. */
export function redactConfigCredentials(text: string): string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      try {
        return JSON.stringify(scrub(JSON.parse(value)));
      } catch {
        return redactAssignments(value);
      }
    }
    if (Array.isArray(value)) {
      return value.map(scrub);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          credential.test(key) ? "<redacted>" : scrub(child),
        ]),
      );
    }
    return value;
  };
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
  });
  if (!errors.length && parsed && typeof parsed === "object") {
    return JSON.stringify(scrub(parsed), null, 2);
  }
  return redactAssignments(text);
}
