import { ParseError, applyEdits, modify, parse } from "jsonc-parser";
import * as path from "path";

import { ClientAdapter, ClientConfigInput, PLACEHOLDER_API_KEY } from "./types";

// Antigravity CLI (agy) talks to a custom endpoint only in its Gemini API key
// mode: `"modelProvider": "gemini"` in ~/.gemini/antigravity-cli/settings.json
// plus GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL in the environment (agy
// 1.1.13 release notes). The file part is written here; the environment
// variables are manual steps because agy reads them from the shell.
const PROVIDER = "gemini";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function agyDir(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".gemini", "antigravity-cli");
}

function settingsPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(agyDir(home, platform), "settings.json");
}

function readProvider(text: string | undefined, filePath: string): unknown {
  if (!text || !text.trim()) {
    return undefined;
  }
  const errors: ParseError[] = [];
  // agy accepts files saved with a byte order mark (1.2.16).
  const root = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
  });
  if (
    errors.length > 0 ||
    !root ||
    typeof root !== "object" ||
    Array.isArray(root)
  ) {
    throw new Error(`Cannot parse ${filePath} as JSON.`);
  }
  return (root as Record<string, unknown>).modelProvider;
}

function setProvider(text: string | undefined, value: unknown): string {
  const source = text && text.trim() ? text : "{}\n";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(source, ["modelProvider"], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(source, edits);
}

function envSteps(input: ClientConfigInput): string[] {
  const key = input.apiKey ? "<your gateway API key>" : PLACEHOLDER_API_KEY;
  return input.platform === "win32"
    ? [
        `setx GOOGLE_GEMINI_BASE_URL ${input.gatewayUrl}`,
        `setx GEMINI_API_KEY ${key}`,
      ]
    : [
        `export GOOGLE_GEMINI_BASE_URL=${input.gatewayUrl}`,
        `export GEMINI_API_KEY=${key}`,
      ];
}

export const antigravityAdapter: ClientAdapter = {
  id: "antigravity",
  label: "Antigravity CLI",
  discovery: "manual",
  caveat:
    "Uses agy's Gemini API key mode; agy only offers its own Gemini model names, so the gateway needs a Gemini model of that name or a model alias.",
  detectPaths(home, platform) {
    return [agyDir(home, platform)];
  },
  configPaths(home, platform) {
    return [settingsPath(home, platform)];
  },
  plan(input, files) {
    const target = settingsPath(input.home, input.platform);
    const before = files[target];
    const current = readProvider(before, target);
    const after = current === PROVIDER ? before : setProvider(before, PROVIDER);
    const env = envSteps(input);
    return {
      changes:
        before === after ? [] : [{ path: target, before, after: after! }],
      summary: [
        `Set "modelProvider": "${PROVIDER}" in ${target}; the gateway URL and key are set as environment variables by hand.`,
      ],
      manualSteps: [
        `Set these environment variables, then open a new terminal: ${env.join(" ; ")}`,
        `Run agy and pick a Gemini model with /model or --model. If the gateway has no model of that name, map it with agentGateway.modelMappings (for example {"gemini-3.8-flash": "${input.defaultModel}"}).`,
      ],
      clipboard: [...env, ""].join("\n"),
      afterApply: "Open a new terminal and run agy.",
    };
  },
  unplan(input, files) {
    const target = settingsPath(input.home, input.platform);
    const before = files[target];
    const steps = [
      input.platform === "win32"
        ? "Remove the environment variables: reg delete HKCU\\Environment /v GOOGLE_GEMINI_BASE_URL /f ; reg delete HKCU\\Environment /v GEMINI_API_KEY /f"
        : "Remove the GOOGLE_GEMINI_BASE_URL and GEMINI_API_KEY exports from your shell profile.",
    ];
    if (before === undefined || readProvider(before, target) !== PROVIDER) {
      return {
        changes: [],
        summary: [
          `${target} does not use the Gemini API key mode; nothing to remove.`,
        ],
        manualSteps: steps,
      };
    }
    return {
      changes: [
        { path: target, before, after: setProvider(before, undefined) },
      ],
      summary: [
        `Remove "modelProvider": "${PROVIDER}" from ${target} so agy signs in with Google again.`,
      ],
      manualSteps: steps,
    };
  },
};
