import { ParseError, applyEdits, modify, parse } from "jsonc-parser";
import * as path from "path";

import { ALIAS_PREFIX } from "../gateway/catalog";
import { selectedContextWindow } from "./contextWindow";
import {
  ClientAdapter,
  ClientConfigInput,
  ClientPlan,
  PLACEHOLDER_API_KEY,
} from "./types";

const MANAGED_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_MODEL",
  // Auto mode's server-side checks need Anthropic's API; through the gateway
  // Claude Code uses its own classifier, and this skips the notice about it.
  "CLAUDE_CODE_AUTO_MODE_SERVER",
] as const;
const PREVIOUS_KEY = "AGENT_GATEWAY_PREVIOUS";
const CONTEXT_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
const OUTPUT_KEY = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
const DEFAULT_OUTPUT_TOKENS = "128000";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function settingsPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".claude", "settings.json");
}

function cachePath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(
    home,
    ".claude",
    "cache",
    "gateway-models.json",
  );
}

function readEnv(text: string | undefined): Record<string, unknown> {
  if (!text || !text.trim()) {
    return {};
  }
  const errors: ParseError[] = [];
  const root = parse(text, errors, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    !root ||
    typeof root !== "object" ||
    Array.isArray(root)
  ) {
    throw new Error(
      "Claude Code settings.json is not valid JSON; fix it before configuring Claude Code.",
    );
  }
  const env = (root as Record<string, unknown>).env;
  return env && typeof env === "object" && !Array.isArray(env)
    ? (env as Record<string, unknown>)
    : {};
}

function setValue(text: string, keyPath: string[], value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(text, keyPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(text, edits);
}

function desiredValues(input: ClientConfigInput): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: input.apiKey || PLACEHOLDER_API_KEY,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Use the catalog's Claude-compatible alias only for this client.
    ANTHROPIC_MODEL: input.defaultModel.startsWith(ALIAS_PREFIX)
      ? input.defaultModel
      : ALIAS_PREFIX + input.defaultModel,
    CLAUDE_CODE_AUTO_MODE_SERVER: "0",
  };
}

/** Track context ownership independently, including upgrades from older backups. */
function configureContext(
  text: string,
  input: ClientConfigInput,
  summary: string[],
): string {
  const env = readEnv(text);
  const capacity = selectedContextWindow(input);
  const saved: unknown =
    typeof env[PREVIOUS_KEY] === "string" ? JSON.parse(env[PREVIOUS_KEY]) : {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new Error(
      "Claude Code gateway backup is invalid; restore it before configuring.",
    );
  }
  const previous = saved as Record<string, unknown>;
  if (capacity !== undefined) {
    if (!Object.hasOwn(previous, CONTEXT_KEY)) {
      previous[CONTEXT_KEY] = env[CONTEXT_KEY] ?? null;
      text = setValue(text, ["env", PREVIOUS_KEY], JSON.stringify(previous));
    }
    text = setValue(text, ["env", CONTEXT_KEY], String(capacity));
    summary.push(
      "Set " +
        CONTEXT_KEY +
        "=" +
        capacity +
        " from the selected model's advertised context window.",
    );
  } else {
    if (Object.hasOwn(previous, CONTEXT_KEY)) {
      text = setValue(
        text,
        ["env", CONTEXT_KEY],
        previous[CONTEXT_KEY] ?? undefined,
      );
    }
    summary.push(
      "Context window unavailable; no capacity is guessed and any gateway context override is restored.",
    );
  }
  return text;
}

export const claudeCodeAdapter: ClientAdapter = {
  id: "claude-code",
  label: "Claude Code CLI / Claude desktop Code tab",
  discovery: "auto",
  caveat:
    "Claude desktop chat is not configurable; the desktop Code tab is assumed to read the same ~/.claude/settings.json.",
  detectPaths(home, platform) {
    return [pathApi(platform).join(home, ".claude")];
  },
  configPaths(home, platform) {
    return [settingsPath(home, platform)];
  },
  plan(input, files): ClientPlan {
    const file = settingsPath(input.home, input.platform);
    const cache = cachePath(input.home, input.platform);
    const before = files[file];
    const env = readEnv(before);
    const desired = desiredValues(input);
    let text = before && before.trim() ? before : "{}\n";
    const summary = [
      `Set env ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL=${desired.ANTHROPIC_MODEL}, gateway model discovery and CLAUDE_CODE_AUTO_MODE_SERVER=0 in ${file}.`,
    ];
    if (!(PREVIOUS_KEY in env)) {
      const previous: Record<string, unknown> = {};
      let differs = false;
      for (const key of MANAGED_KEYS) {
        previous[key] = key in env ? env[key] : null;
        // Record whenever the user already owns a managed key, even if it
        // equals the desired value, so unplan never deletes user-owned keys.
        if (key in env) {
          differs = true;
        }
      }
      if (differs) {
        text = setValue(text, ["env", PREVIOUS_KEY], JSON.stringify(previous));
        summary.push(
          `Recorded previous values in env.${PREVIOUS_KEY} so they can be restored.`,
        );
      }
    }
    for (const key of MANAGED_KEYS) {
      if (env[key] !== desired[key]) {
        text = setValue(text, ["env", key], desired[key]);
      }
    }
    // Record ownership separately so older backups can be upgraded without
    // replacing their original values, and legacy unconfigure stays safe.
    const configuredEnv = readEnv(text);
    let previous: Record<string, unknown> = {};
    if (typeof configuredEnv[PREVIOUS_KEY] === "string") {
      const saved: unknown = JSON.parse(configuredEnv[PREVIOUS_KEY]);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error(
          "Claude Code gateway backup is invalid; restore it before configuring.",
        );
      }
      previous = saved as Record<string, unknown>;
    }
    if (!(OUTPUT_KEY in previous)) {
      previous[OUTPUT_KEY] = OUTPUT_KEY in env ? env[OUTPUT_KEY] : null;
      text = setValue(text, ["env", PREVIOUS_KEY], JSON.stringify(previous));
    }
    if (!(OUTPUT_KEY in env)) {
      text = setValue(text, ["env", OUTPUT_KEY], DEFAULT_OUTPUT_TOKENS);
    }
    summary.push(
      `${OUTPUT_KEY}=${env[OUTPUT_KEY] ?? DEFAULT_OUTPUT_TOKENS} (${OUTPUT_KEY in env ? "preserved existing value" : "gateway default"}).`,
    );
    text = configureContext(text, input, summary);
    summary.push(`If /model does not list gateway models, delete ${cache}.`);
    return {
      changes: text === before ? [] : [{ path: file, before, after: text }],
      summary,
      afterApply: `Restart Claude Code; /model shows "From gateway" models (delete ${cache} if the list is stale).`,
    };
  },
  unplan(input, files): ClientPlan {
    const file = settingsPath(input.home, input.platform);
    const before = files[file];
    if (before === undefined) {
      return {
        changes: [],
        summary: [`${file} does not exist; nothing to remove.`],
      };
    }
    const env = readEnv(before);
    let previous: Record<string, unknown> | undefined;
    if (typeof env[PREVIOUS_KEY] === "string") {
      try {
        previous = JSON.parse(env[PREVIOUS_KEY] as string);
      } catch {
        previous = undefined;
      }
    }
    let text = before;
    for (const key of MANAGED_KEYS) {
      const prev = previous ? previous[key] : undefined;
      if (prev !== null && prev !== undefined) {
        if (env[key] !== prev) {
          text = setValue(text, ["env", key], prev);
        }
      } else if (key in env) {
        text = setValue(text, ["env", key], undefined);
      }
    }
    // Backups from older versions do not own this setting.
    if (previous && Object.hasOwn(previous, OUTPUT_KEY)) {
      text = setValue(
        text,
        ["env", OUTPUT_KEY],
        previous[OUTPUT_KEY] ?? undefined,
      );
    }
    if (previous && Object.hasOwn(previous, CONTEXT_KEY)) {
      text = setValue(
        text,
        ["env", CONTEXT_KEY],
        previous[CONTEXT_KEY] ?? undefined,
      );
    }
    if (PREVIOUS_KEY in env) {
      text = setValue(text, ["env", PREVIOUS_KEY], undefined);
    }
    const summary = [
      previous
        ? `Restored previous Claude Code env values in ${file}.`
        : `Removed gateway env keys from ${file}; no previous values were recorded, so they are left unset.`,
    ];
    return {
      changes: text === before ? [] : [{ path: file, before, after: text }],
      summary,
    };
  },
};
