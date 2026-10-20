import { ParseError, applyEdits, modify, parse } from "jsonc-parser";
import * as path from "path";

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
    ANTHROPIC_MODEL: input.defaultModel,
    CLAUDE_CODE_AUTO_MODE_SERVER: "0",
  };
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
      `Set env ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL=${input.defaultModel}, gateway model discovery and CLAUDE_CODE_AUTO_MODE_SERVER=0 in ${file}.`,
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
