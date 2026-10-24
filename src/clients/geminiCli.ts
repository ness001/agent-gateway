import { ParseError, applyEdits, modify, parse } from "jsonc-parser";
import * as path from "path";

import { ClientAdapter, ClientConfigInput, PLACEHOLDER_API_KEY } from "./types";

const START = "# agent-gateway:start";
const END = "# agent-gateway:end";
const AUTH_PATH = ["security", "auth", "selectedType"];
const AUTH = "gemini-api-key";

/** Gemini CLI's utils/paths.ts treats GEMINI_CLI_HOME as the home, not .gemini. */
export function geminiCliDir(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(env.GEMINI_CLI_HOME || home, ".gemini");
}

function paths(home: string, platform: NodeJS.Platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = geminiCliDir(home, platform);
  return [
    p.join(dir, ".env"),
    p.join(dir, "settings.json"),
    p.join(dir, "agent-gateway.json"),
  ];
}

function readSettings(text: string | undefined): Record<string, any> {
  if (!text?.trim()) {
    return {};
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Gemini CLI settings.json is not valid JSON; fix it before configuring.",
    );
  }
  return value;
}

function setAuth(text: string, value: unknown): string {
  return applyEdits(
    text,
    modify(text, AUTH_PATH, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}

interface Previous {
  settingsBefore: string | null;
  settingsAfter: string;
  envBefore: string | null;
  envAfter: string;
}

function readPrevious(text: string | undefined): Previous | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Gemini CLI gateway backup is invalid; restore it before configuring.",
    );
  }
  const saved = value as Previous;
  if (
    !(
      saved.settingsBefore === null || typeof saved.settingsBefore === "string"
    ) ||
    typeof saved.settingsAfter !== "string" ||
    !(saved.envBefore === null || typeof saved.envBefore === "string") ||
    typeof saved.envAfter !== "string"
  ) {
    throw new Error(
      "Gemini CLI gateway backup is invalid; restore it before configuring.",
    );
  }
  return saved;
}

function quoteEnv(value: string): string {
  // dotenv accepts single/backtick quotes literally; double quotes expand \\n.
  for (const quote of ["'", "`"]) {
    if (!value.includes(quote) && !/[\r\n]/.test(value)) {
      return quote + value + quote;
    }
  }
  throw new Error(
    "Gemini CLI gateway values cannot contain both single quotes and backticks or line breaks.",
  );
}

function envBlock(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(START);
  if (start < 0) {
    return undefined;
  }
  const end = text.indexOf(END, start);
  if (end < 0 || text.indexOf(START, start + START.length) >= 0) {
    throw new Error(
      "Gemini CLI gateway environment block is invalid; restore it before configuring.",
    );
  }
  let after = end + END.length;
  if (text.slice(after).startsWith("\r\n")) {
    after += 2;
  } else if (text[after] === "\n") {
    after++;
  }
  return { start, end: after };
}

function configureEnv(
  input: ClientConfigInput,
  before: string | undefined,
): string {
  const text = before ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    START,
    `GOOGLE_GEMINI_BASE_URL=${quoteEnv(input.gatewayUrl)}`,
    `GEMINI_API_KEY=${quoteEnv(input.apiKey ?? PLACEHOLDER_API_KEY)}`,
    `GEMINI_MODEL=${quoteEnv(input.defaultModel)}`,
    END,
    "",
  ].join(eol);
  const existing = envBlock(text);
  return existing
    ? text.slice(0, existing.start) + block + text.slice(existing.end)
    : text + (text && !text.endsWith("\n") ? eol : "") + block;
}

export const geminiCliAdapter: ClientAdapter = {
  id: "gemini-cli",
  label: "Gemini CLI",
  discovery: "single",
  caveat:
    "Existing shell variables, --model, workspace settings or a nearer .env can override this user configuration. Sandboxed/untrusted workspaces may not load the endpoint; not verified live.",
  detectPaths(home, platform) {
    return [geminiCliDir(home, platform)];
  },
  configPaths: paths,
  plan(input, files) {
    const [env, settings, backup] = paths(input.home, input.platform);
    const original = readPrevious(files[backup]);
    if (!original && envBlock(files[env] ?? "")) {
      throw new Error(
        "Gemini CLI gateway backup is missing; restore it before configuring.",
      );
    }
    const current = readSettings(files[settings]);
    const settingsAfter =
      current.security?.auth?.selectedType === AUTH
        ? files[settings]!
        : setAuth(files[settings]?.trim() ? files[settings]! : "{}\n", AUTH);
    const envAfter = configureEnv(input, files[env]);
    const saved: Previous = {
      settingsBefore: original
        ? original.settingsBefore
        : (files[settings] ?? null),
      settingsAfter: original ? original.settingsAfter : settingsAfter,
      envBefore: original ? original.envBefore : (files[env] ?? null),
      envAfter: configureEnv(
        input,
        original ? (original.envBefore ?? undefined) : files[env],
      ),
    };
    const desired = [
      envAfter,
      settingsAfter,
      JSON.stringify(saved, null, 2) + "\n",
    ];
    return {
      changes: [env, settings, backup].flatMap((file, i) =>
        files[file] === desired[i]
          ? []
          : [{ path: file, before: files[file], after: desired[i] }],
      ),
      summary: [
        `Set the gateway URL, API key and GEMINI_MODEL=${input.defaultModel} in ${env}.`,
        `Select Gemini API-key authentication in ${settings}; record previous values in ${backup}.`,
      ],
      afterApply:
        "Restart Gemini CLI. Existing shell variables or workspace .env/settings may override the user configuration.",
    };
  },
  unplan(input, files) {
    const [env, settings, backup] = paths(input.home, input.platform);
    const saved = readPrevious(files[backup]);
    if (!saved) {
      return {
        changes: [],
        summary: ["No Gemini CLI gateway configuration to remove."],
      };
    }
    let envAfter = files[env];
    if (envAfter === saved.envAfter) {
      envAfter = saved.envBefore ?? undefined;
    } else if (envAfter !== undefined) {
      const block = envBlock(envAfter);
      if (block) {
        envAfter = envAfter.slice(0, block.start) + envAfter.slice(block.end);
      }
    }
    let settingsAfter = files[settings];
    if (settingsAfter === saved.settingsAfter) {
      settingsAfter = saved.settingsBefore ?? undefined;
    } else if (settingsAfter !== undefined) {
      const current = readSettings(settingsAfter);
      if (current.security?.auth?.selectedType === AUTH) {
        const previous = readSettings(saved.settingsBefore ?? undefined);
        settingsAfter = setAuth(
          settingsAfter,
          previous.security?.auth?.selectedType,
        );
      }
    }
    const desired = [envAfter, settingsAfter, undefined];
    return {
      changes: [env, settings, backup].flatMap((file, i) =>
        files[file] === desired[i]
          ? []
          : [{ path: file, before: files[file], after: desired[i] }],
      ),
      summary: [
        "Restore previous Gemini CLI environment and authentication settings; preserve unrelated edits.",
      ],
      afterApply: "Restart Gemini CLI.",
    };
  },
};
