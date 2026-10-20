import * as path from "path";

import {
  type ClientAdapter,
  type ClientConfigInput,
  type ClientPlan,
  PLACEHOLDER_API_KEY,
} from "./types";

// Cline CLI (v3) keeps provider settings in ~/.cline/data/settings/providers.json,
// the same file `cline auth openai -b <url> -k <key> -m <model>` writes. The
// entry key and provider id are fixed by Cline, so the gateway owns the
// "openai-compatible" slot while configured.
const PROVIDER = "openai-compatible";

interface ProviderEntry {
  settings: Record<string, unknown>;
  updatedAt: string;
  tokenSource?: string;
}

interface ProvidersFile {
  version: 1;
  lastUsedProvider?: string;
  modes?: Record<string, unknown>;
  providers: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function clineDir(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".cline");
}

function providersPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(
    clineDir(home, platform),
    "data",
    "settings",
    "providers.json",
  );
}

function baseUrl(input: ClientConfigInput): string {
  return `${input.gatewayUrl.replace(/\/+$/, "")}/v1`;
}

function change(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
): ClientPlan["changes"] {
  return before === after ? [] : [{ path: filePath, before, after }];
}

function read(text: string | undefined, filePath: string): ProvidersFile {
  if (text === undefined || text.trim() === "") {
    return { version: 1, modes: {}, providers: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Cannot parse ${filePath} as JSON.`);
  }
  const file = value as ProvidersFile | null;
  if (
    !file ||
    typeof file !== "object" ||
    file.version !== 1 ||
    !file.providers ||
    typeof file.providers !== "object"
  ) {
    throw new Error(`${filePath} is not a Cline providers file (version 1).`);
  }
  return file;
}

function write(file: ProvidersFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** True when the openai-compatible entry points at this gateway. */
function isGatewayEntry(
  entry: ProviderEntry | undefined,
  input: ClientConfigInput,
): boolean {
  return entry?.settings?.baseUrl === baseUrl(input);
}

export const clineAdapter: ClientAdapter = {
  id: "cline",
  label: "Cline",
  discovery: "single",
  caveat:
    "Configures the Cline CLI (~/.cline). The Cline VS Code extension keeps its settings in VS Code storage; set it to OpenAI Compatible with the same base URL by hand.",
  detectPaths(home, platform) {
    return [clineDir(home, platform)];
  },
  configPaths(home, platform) {
    return [providersPath(home, platform)];
  },
  plan(input, files) {
    const target = providersPath(input.home, input.platform);
    const before = files[target];
    const file = read(before, target);
    const settings = {
      provider: PROVIDER,
      apiKey: input.apiKey || PLACEHOLDER_API_KEY,
      model: input.defaultModel,
      baseUrl: baseUrl(input),
    };
    const current = file.providers[PROVIDER];
    const same =
      current !== undefined &&
      JSON.stringify(current.settings) === JSON.stringify(settings);
    if (!same) {
      file.providers[PROVIDER] = {
        settings,
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      };
    }
    file.lastUsedProvider = PROVIDER;
    file.modes ??= {};
    const after = write(file);
    const summary = [
      `Set Cline provider "${PROVIDER}" to ${baseUrl(input)} with model ${input.defaultModel} in ${target}.`,
    ];
    if (current !== undefined && !isGatewayEntry(current, input)) {
      summary.push(
        `Replaces the existing "${PROVIDER}" entry (base URL ${String(current.settings?.baseUrl)}); a backup is kept.`,
      );
    }
    return {
      changes: change(target, before, after),
      summary,
      afterApply: `Run cline in a new terminal; use cline -m <model> to pick another gateway model.`,
    };
  },
  unplan(input, files) {
    const target = providersPath(input.home, input.platform);
    const before = files[target];
    if (before === undefined) {
      return {
        changes: [],
        summary: [`${target} does not exist; nothing to remove.`],
      };
    }
    const file = read(before, target);
    if (!isGatewayEntry(file.providers[PROVIDER], input)) {
      return {
        changes: [],
        summary: [
          `${target} has no "${PROVIDER}" entry for this gateway; nothing to remove.`,
        ],
      };
    }
    delete file.providers[PROVIDER];
    if (file.lastUsedProvider === PROVIDER) {
      const next = Object.keys(file.providers)[0];
      if (next === undefined) {
        delete file.lastUsedProvider;
      } else {
        file.lastUsedProvider = next;
      }
    }
    return {
      changes: change(target, before, write(file)),
      summary: [`Remove provider "${PROVIDER}" from ${target}.`],
    };
  },
};
