import {
  type FormattingOptions,
  type ParseError,
  applyEdits,
  modify,
  parse,
} from "jsonc-parser";
import * as path from "path";

import { validContextWindow } from "./contextWindow";
import {
  type ClientAdapter,
  type ClientConfigInput,
  type ClientPlan,
  GATEWAY_PROVIDER_ID,
  GATEWAY_PROVIDER_NAME,
  type GatewayModel,
  PLACEHOLDER_API_KEY,
} from "./types";

// Kilo CLI (an OpenCode fork) reads ~/.config/kilo/kilo.json[c] on every
// platform. Custom providers use the OpenCode schema: an AI SDK package,
// options.baseURL, and a static models map (no discovery for custom providers).

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
function backupPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(
    home,
    ".config",
    "kilo",
    "agent-gateway-default.json",
  );
}

interface PreviousModel {
  model: string | null;
  configExisted: boolean;
}

function previousModel(text: string | undefined): PreviousModel | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kilo gateway model backup is invalid.");
  }
  const { model, configExisted } = value as Record<string, unknown>;
  if (
    (model !== null && typeof model !== "string") ||
    typeof configExisted !== "boolean"
  ) {
    throw new Error("Kilo gateway model backup is invalid.");
  }
  return { model, configExisted };
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function kiloDir(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".config", "kilo");
}

function kiloPaths(
  home: string,
  platform: NodeJS.Platform,
): { jsonc: string; json: string } {
  const dir = kiloDir(home, platform);
  const p = pathApi(platform);
  return { jsonc: p.join(dir, "kilo.jsonc"), json: p.join(dir, "kilo.json") };
}

/** kilo.jsonc wins; kilo.json is edited only when it is the sole file. */
function kiloTarget(
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): string {
  const { jsonc, json } = kiloPaths(input.home, input.platform);
  return files[jsonc] === undefined && files[json] !== undefined ? json : jsonc;
}

function kiloModels(models: GatewayModel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of models) {
    if (
      m.supportsToolCalling === false ||
      m.id.startsWith("copilot-utility") ||
      m.id.startsWith("copilot-dictation")
    ) {
      continue;
    }
    const entry: Record<string, unknown> = {
      name: m.displayName || m.id,
      tool_call: true,
      reasoning: m.reasoning,
      attachment: m.inputModalities.includes("image"),
    };
    const context = validContextWindow(m.contextWindow);
    if (context !== undefined || m.maxOutputTokens !== undefined) {
      entry.limit = {
        ...(context !== undefined ? { context } : {}),
        ...(m.maxOutputTokens !== undefined
          ? { output: m.maxOutputTokens }
          : {}),
      };
    }
    out[m.id] = entry;
  }
  return out;
}

function parseJsonc(text: string, filePath: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Cannot parse ${filePath} as JSON.`);
  }
  return value;
}

function edit(
  text: string,
  keyPath: (string | number)[],
  value: unknown,
): string {
  return applyEdits(
    text,
    modify(text, keyPath, value, { formattingOptions: FORMAT }),
  );
}

function change(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
): ClientPlan["changes"] {
  return before === after ? [] : [{ path: filePath, before, after }];
}

export const kiloAdapter: ClientAdapter = {
  id: "kilo",
  label: "Kilo Code",
  discovery: "static",
  caveat:
    "Kilo has no model discovery for custom providers; re-run to refresh the model list.",
  detectPaths(home, platform) {
    return [kiloDir(home, platform)];
  },
  configPaths(home, platform) {
    const { jsonc, json } = kiloPaths(home, platform);
    return [jsonc, json, backupPath(home, platform)];
  },
  plan(input, files) {
    const target = kiloTarget(input, files);
    const before = files[target];
    let text = before === undefined || before.trim() === "" ? "{}\n" : before;
    const root = parseJsonc(text, target);
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      throw new Error(
        `Cannot safely edit ${target}: config must be an object.`,
      );
    }
    const models = kiloModels(input.models);
    if (!Object.hasOwn(models, input.defaultModel)) {
      throw new Error(
        `Selected model ${input.defaultModel} is not available in Kilo's model list.`,
      );
    }
    const backup = backupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = previousModel(backupBefore);
    const originalModel = (root as Record<string, unknown>).model;
    const gatewayModel =
      typeof originalModel === "string" &&
      originalModel.startsWith(`${GATEWAY_PROVIDER_ID}/`);
    if (originalModel !== undefined && typeof originalModel !== "string") {
      throw new Error(
        `Cannot safely save Kilo's previous default in ${target}.`,
      );
    }
    const refresh = previous !== undefined && !gatewayModel;
    const backupAfter =
      gatewayModel && previous === undefined
        ? undefined // Legacy gateway selection: the earlier default is unknown.
        : backupBefore === undefined || refresh
          ? JSON.stringify(
              {
                model: originalModel ?? null,
                configExisted: refresh
                  ? previous!.configExisted
                  : before !== undefined,
              },
              null,
              2,
            ) + "\n"
          : backupBefore;
    const key = ["provider", GATEWAY_PROVIDER_ID];
    text = edit(text, [...key, "npm"], "@ai-sdk/openai-compatible");
    text = edit(text, [...key, "name"], GATEWAY_PROVIDER_NAME);
    text = edit(
      text,
      [...key, "options", "baseURL"],
      `${input.gatewayUrl.replace(/\/+$/, "")}/v1`,
    );
    text = edit(
      text,
      [...key, "options", "apiKey"],
      input.apiKey || PLACEHOLDER_API_KEY,
    );
    text = edit(text, [...key, "models"], models);
    text = edit(
      text,
      ["model"],
      `${GATEWAY_PROVIDER_ID}/${input.defaultModel}`,
    );
    return {
      changes: [
        ...change(backup, backupBefore, backupAfter),
        ...change(target, before, text),
      ],
      summary: [
        `Write provider "${GATEWAY_PROVIDER_ID}" with ${Object.keys(models).length} model(s) to ${target}.`,
        `Set Kilo's default model to ${GATEWAY_PROVIDER_ID}/${input.defaultModel} in ${target}.`,
      ],
      afterApply:
        "Restart Kilo to use the selected default model in new sessions.",
    };
  },
  unplan(input, files) {
    const target = kiloTarget(input, files);
    const before = files[target];
    const root = before === undefined ? null : parseJsonc(before, target);
    if (
      before !== undefined &&
      (root === null || typeof root !== "object" || Array.isArray(root))
    ) {
      throw new Error(
        `Cannot safely remove Kilo's provider: ${target} must be an object.`,
      );
    }
    const config = root as {
      provider?: Record<string, unknown>;
      model?: unknown;
    } | null;
    if (
      config?.provider !== undefined &&
      (config.provider === null ||
        typeof config.provider !== "object" ||
        Array.isArray(config.provider))
    ) {
      throw new Error(
        `Cannot safely remove Kilo's provider: provider must be an object.`,
      );
    }
    const backup = backupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = previousModel(backupBefore);
    if (before === undefined) {
      if (previous?.configExisted) {
        throw new Error(
          `Cannot safely restore Kilo's previous default in ${target}: the config file is missing.`,
        );
      }
      return {
        changes: change(backup, backupBefore, undefined),
        summary: [
          `${target} does not exist; removed the saved gateway default.`,
        ],
      };
    }
    if (!config?.provider || !(GATEWAY_PROVIDER_ID in config.provider)) {
      let text = before;
      if (
        previous !== undefined &&
        typeof config?.model === "string" &&
        config.model.startsWith(`${GATEWAY_PROVIDER_ID}/`)
      ) {
        text = edit(text, ["model"], previous.model ?? undefined);
      } else if (
        previous === undefined &&
        typeof config?.model === "string" &&
        config.model.startsWith(`${GATEWAY_PROVIDER_ID}/`)
      ) {
        text = edit(text, ["model"], undefined);
      }
      return {
        changes: [
          ...change(target, before, text),
          ...change(backup, backupBefore, undefined),
        ],
        summary: [
          `${target} has no "${GATEWAY_PROVIDER_ID}" provider; restored any managed default.`,
        ],
      };
    }
    let text = edit(before, ["provider", GATEWAY_PROVIDER_ID], undefined);
    if (
      previous !== undefined &&
      typeof config.model === "string" &&
      config.model.startsWith(`${GATEWAY_PROVIDER_ID}/`)
    ) {
      text = edit(text, ["model"], previous.model ?? undefined);
    } else if (
      previous === undefined &&
      typeof config.model === "string" &&
      config.model.startsWith(`${GATEWAY_PROVIDER_ID}/`)
    ) {
      text = edit(text, ["model"], undefined);
    }
    const rest = parseJsonc(text, target) as Record<string, unknown>;
    if (rest.provider && Object.keys(rest.provider).length === 0) {
      text = edit(text, ["provider"], undefined);
    }
    const after =
      !previous?.configExisted &&
      Object.keys(parseJsonc(text, target) as object).length === 0 &&
      !/\/[/*]/.test(text)
        ? undefined
        : text;
    return {
      changes: [
        ...change(target, before, after),
        ...change(backup, backupBefore, undefined),
      ],
      summary: [
        `Remove provider "${GATEWAY_PROVIDER_ID}" and restore the previous default model in ${target}.`,
      ],
    };
  },
};
