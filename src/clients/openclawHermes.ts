import {
  ParseError,
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import * as path from "path";
import { Scalar, isMap, parseDocument } from "yaml";

import { validContextWindow } from "./contextWindow";
import {
  ClientAdapter,
  ClientConfigInput,
  ClientPlan,
  GATEWAY_PROVIDER_ID,
  GatewayModel,
  PLACEHOLDER_API_KEY,
} from "./types";

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function keyOf(input: ClientConfigInput): string {
  return input.apiKey || PLACEHOLDER_API_KEY;
}

/** Models usable by an agent: tool calling not explicitly unsupported. */
function agentModels(models: GatewayModel[]): GatewayModel[] {
  return models.filter((m) => m.supportsToolCalling !== false);
}

function change(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
): ClientPlan["changes"] {
  return before === after ? [] : [{ path: filePath, before, after }];
}

// ---------------------------------------------------------------- OpenClaw

const PREV_MARKER = "// agent-gateway:previous-primary=";
const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

type Env = Record<string, string | undefined>;

function expandTilde(
  value: string,
  home: string,
  platform: NodeJS.Platform,
): string {
  const p = pathFor(platform);
  return p.resolve(value.replace(/^~(?=$|[\\/])/, () => home));
}

/**
 * OpenClaw state dir, mirroring OpenClaw's src/config/state-dir.ts:
 * OPENCLAW_STATE_DIR, else <OPENCLAW_HOME or OS home>/.openclaw (same on
 * Windows, no AppData).
 */
export function openclawStateDir(
  home: string,
  platform: NodeJS.Platform,
  env: Env = process.env,
): string {
  const effectiveHome = openclawEffectiveHome(home, platform, env);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return expandTilde(override, effectiveHome, platform);
  }
  return pathFor(platform).join(effectiveHome, ".openclaw");
}

/** OPENCLAW_CONFIG_PATH, else <state dir>/openclaw.json (src/config/paths.ts). */
export function openclawConfigPath(
  home: string,
  platform: NodeJS.Platform,
  env: Env = process.env,
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return expandTilde(
      override,
      openclawEffectiveHome(home, platform, env),
      platform,
    );
  }
  return pathFor(platform).join(
    openclawStateDir(home, platform, env),
    "openclaw.json",
  );
}

function openclawEffectiveHome(
  home: string,
  platform: NodeJS.Platform,
  env: Env,
): string {
  const explicitHome = env.OPENCLAW_HOME?.trim();
  return explicitHome ? expandTilde(explicitHome, home, platform) : home;
}

function openclawPath(home: string, platform: NodeJS.Platform): string {
  return openclawConfigPath(home, platform);
}

function parseJsonc(text: string): { value: any; error?: string } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    return {
      value: undefined,
      error:
        printParseErrorCode(errors[0].error) + " at offset " + errors[0].offset,
    };
  }
  return { value };
}

function set(
  text: string,
  jsonPath: (string | number)[],
  value: unknown,
): string {
  return applyEdits(
    text,
    modify(text, jsonPath, value, { formattingOptions: FORMAT }),
  );
}

function readMarker(text: string): { found: boolean; value: string | null } {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(PREV_MARKER));
  if (!line) {
    return { found: false, value: null };
  }
  try {
    return {
      found: true,
      value: JSON.parse(line.trim().slice(PREV_MARKER.length)),
    };
  } catch {
    return { found: true, value: null };
  }
}

function stripMarker(text: string): string {
  return text
    .split(/(?<=\n)/)
    .filter((l) => !l.trim().startsWith(PREV_MARKER))
    .join("");
}

function refuseOpenclaw(p: string, error: string): ClientPlan {
  return {
    changes: [],
    summary: [
      `Cannot safely edit ${p}: it is not parseable as JSON with comments (${error}).`,
    ],
    manualSteps: [
      `Open ${p} and merge models.providers.${GATEWAY_PROVIDER_ID} and agents.defaults.model.primary by hand,`,
      "or quote all keys so it can be edited automatically.",
    ],
  };
}

export const openclawAdapter: ClientAdapter = {
  id: "openclaw",
  label: "OpenClaw",
  discovery: "static",
  caveat:
    "Config path and schema (models.providers, api: anthropic-messages, agents.defaults.model.primary) checked against OpenClaw's public docs and source, not a live install.",
  detectPaths: (home, platform) => [openclawStateDir(home, platform)],
  configPaths: (home, platform) => [openclawPath(home, platform)],
  plan(input, files) {
    const p = openclawPath(input.home, input.platform);
    const before = files[p];
    let text = before === undefined || before.trim() === "" ? "{}\n" : before;
    const parsed = parseJsonc(text);
    if (
      parsed.error ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      Array.isArray(parsed.value)
    ) {
      return refuseOpenclaw(p, parsed.error ?? "top level is not an object");
    }
    const root = parsed.value;
    const summary: string[] = [];
    if (root.models?.mode === undefined) {
      text = set(text, ["models", "mode"], "merge");
    }
    const models = agentModels(input.models).map((m) => {
      const entry: Record<string, unknown> = {
        id: m.id,
        name: m.displayName || m.id,
        reasoning: m.reasoning,
        input: m.inputModalities.includes("image")
          ? ["text", "image"]
          : ["text"],
      };
      const contextWindow = validContextWindow(m.contextWindow);
      if (contextWindow !== undefined) {
        entry.contextWindow = contextWindow;
      }
      if (m.maxOutputTokens) {
        entry.maxTokens = m.maxOutputTokens;
      }
      return entry;
    });
    text = set(text, ["models", "providers", GATEWAY_PROVIDER_ID], {
      baseUrl: input.gatewayUrl,
      apiKey: keyOf(input),
      api: "anthropic-messages",
      models,
    });
    summary.push(
      `Write ${models.length} models to models.providers.${GATEWAY_PROVIDER_ID} in ${p}.`,
    );

    const newPrimary = `${GATEWAY_PROVIDER_ID}/${input.defaultModel}`;
    const prev = root.agents?.defaults?.model?.primary;
    if (!readMarker(text).found && prev !== newPrimary) {
      const prevValue = typeof prev === "string" ? prev : null;
      text =
        text.replace(/\s*$/, "") +
        "\n" +
        PREV_MARKER +
        JSON.stringify(prevValue) +
        "\n";
    }
    text = set(text, ["agents", "defaults", "model", "primary"], newPrimary);
    summary.push(`Set agents.defaults.model.primary to ${newPrimary}.`);
    return {
      changes: text === before ? [] : [{ path: p, before, after: text }],
      summary,
      afterApply:
        "Restart OpenClaw (gateway/daemon or CLI session) to reload openclaw.json.",
    };
  },
  unplan(input, files) {
    const p = openclawPath(input.home, input.platform);
    const before = files[p];
    if (before === undefined) {
      return {
        changes: [],
        summary: [`${p} does not exist; nothing to remove.`],
      };
    }
    const parsed = parseJsonc(before);
    if (
      parsed.error ||
      typeof parsed.value !== "object" ||
      parsed.value === null
    ) {
      return refuseOpenclaw(p, parsed.error ?? "top level is not an object");
    }
    const root = parsed.value;
    let text = before;
    const summary: string[] = [];
    if (root.models?.providers?.[GATEWAY_PROVIDER_ID] !== undefined) {
      text = set(text, ["models", "providers", GATEWAY_PROVIDER_ID], undefined);
      summary.push(`Remove models.providers.${GATEWAY_PROVIDER_ID}.`);
    }
    const primary = root.agents?.defaults?.model?.primary;
    const marker = readMarker(before);
    if (
      typeof primary === "string" &&
      primary.startsWith(GATEWAY_PROVIDER_ID + "/")
    ) {
      if (marker.found && marker.value) {
        text = set(
          text,
          ["agents", "defaults", "model", "primary"],
          marker.value,
        );
        summary.push(
          `Restore agents.defaults.model.primary to ${marker.value}.`,
        );
      } else {
        text = set(text, ["agents", "defaults", "model", "primary"], undefined);
        summary.push(
          "Unset agents.defaults.model.primary (previous value unknown).",
        );
      }
    }
    text = stripMarker(text);
    return {
      changes: text === before ? [] : [{ path: p, before, after: text }],
      summary,
    };
  },
};

// ---------------------------------------------------------------- Hermes

/**
 * Hermes home: HERMES_HOME when set, else %LOCALAPPDATA%\hermes on Windows and
 * ~/.hermes elsewhere (checked against Hermes 0.19 on Windows, 2026-10-20).
 */
export function hermesHome(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.HERMES_HOME?.trim();
  if (override) {
    return override;
  }
  const p = pathFor(platform);
  return platform === "win32"
    ? p.join(home, "AppData", "Local", "hermes")
    : p.join(home, ".hermes");
}

function hermesPath(home: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(hermesHome(home, platform), "config.yaml");
}

function hermesBackupPath(home: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(
    hermesHome(home, platform),
    "agent-gateway-default.json",
  );
}

function hermesPrevious(text: string | undefined): {
  found: boolean;
  provider: string | null;
  model: string | null;
  context: number | null;
  scalarModel: string | undefined;
  legacy: boolean;
} {
  if (text === undefined) {
    return {
      found: false,
      provider: null,
      model: null,
      context: null,
      scalarModel: undefined,
      legacy: false,
    };
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes gateway model backup is invalid.");
  }
  const { provider, model, context, scalarModel, legacy } = value as Record<
    string,
    unknown
  >;
  if (
    !(
      (provider === null || typeof provider === "string") &&
      (model === null || typeof model === "string") &&
      (context === null || typeof context === "number") &&
      (scalarModel === undefined || typeof scalarModel === "string") &&
      (legacy === undefined || typeof legacy === "boolean")
    )
  ) {
    throw new Error("Hermes gateway model backup is invalid.");
  }
  return {
    found: true,
    provider,
    model,
    context,
    scalarModel,
    legacy: legacy === true,
  };
}

export const hermesAdapter: ClientAdapter = {
  id: "hermes",
  label: "Hermes Agent",
  discovery: "auto",
  caveat:
    "Hermes uses the configured default in new sessions; command-line and session overrides may take precedence.",
  detectPaths: (home, platform) => [hermesHome(home, platform)],
  configPaths: (home, platform) => [
    hermesPath(home, platform),
    hermesBackupPath(home, platform),
  ],
  plan(input, files) {
    const p = hermesPath(input.home, input.platform);
    const before = files[p];
    const doc = parseDocument(before ?? "");
    if (
      doc.errors.length > 0 ||
      (doc.contents !== null && !isMap(doc.contents))
    ) {
      return {
        changes: [],
        summary: [
          `Cannot safely edit ${p}: ${doc.errors[0]?.message ?? "top level is not a mapping"}.`,
        ],
        manualSteps: [`Add providers.${GATEWAY_PROVIDER_ID} to ${p} by hand.`],
      };
    }
    const entry = {
      api: `${input.gatewayUrl}/v1`,
      api_key: keyOf(input),
      transport: "chat_completions",
      default_model: input.defaultModel,
      discover_models: true,
      models: Object.fromEntries(
        agentModels(input.models).flatMap((m) => {
          const context = validContextWindow(m.contextWindow);
          return context === undefined
            ? []
            : [[m.id, { context_length: context }]];
        }),
      ),
    };
    const backup = hermesBackupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = hermesPrevious(backupBefore);
    const modelBlock = doc.getIn(["model"], true);
    const scalarModel =
      typeof doc.get("model") === "string"
        ? (doc.get("model") as string)
        : undefined;
    if (
      modelBlock !== undefined &&
      modelBlock !== null &&
      !isMap(modelBlock) &&
      scalarModel === undefined
    ) {
      return {
        changes: [],
        summary: [
          `Cannot safely edit ${p}: the global model setting is not a mapping or string.`,
        ],
        manualSteps: [
          `Set model.provider to ${GATEWAY_PROVIDER_ID} and model.default to ${input.defaultModel} in ${p} by hand.`,
        ],
      };
    }
    const originalProvider = isMap(modelBlock)
      ? doc.getIn(["model", "provider"])
      : undefined;
    const originalModel = isMap(modelBlock)
      ? doc.getIn(["model", "default"])
      : scalarModel;
    const originalContext = isMap(modelBlock)
      ? doc.getIn(["model", "context_length"])
      : undefined;
    const gatewaySelected =
      originalProvider === GATEWAY_PROVIDER_ID ||
      originalProvider === `custom:${GATEWAY_PROVIDER_ID}`;
    if (
      (originalProvider !== null &&
        originalProvider !== undefined &&
        typeof originalProvider !== "string") ||
      (originalModel !== null &&
        originalModel !== undefined &&
        typeof originalModel !== "string") ||
      (originalContext !== null &&
        originalContext !== undefined &&
        typeof originalContext !== "number")
    ) {
      return {
        changes: [],
        summary: [`Cannot safely save Hermes's previous model in ${p}.`],
        manualSteps: [`Set model.provider and model.default in ${p} by hand.`],
      };
    }
    const existing = doc.getIn(["providers", GATEWAY_PROVIDER_ID]);
    if (isMap(existing)) {
      for (const [k, v] of Object.entries(entry)) {
        existing.set(k, v);
      }
    } else {
      doc.setIn(["providers", GATEWAY_PROVIDER_ID], entry);
    }
    const selectedContext = validContextWindow(
      input.models.find((m) => m.id === input.defaultModel)?.contextWindow,
    );
    if (scalarModel !== undefined) {
      doc.set("model", {
        provider: GATEWAY_PROVIDER_ID,
        default: input.defaultModel,
        ...(selectedContext === undefined
          ? {}
          : { context_length: selectedContext }),
      });
    } else {
      doc.setIn(["model", "provider"], GATEWAY_PROVIDER_ID);
      doc.setIn(["model", "default"], input.defaultModel);
      if (selectedContext !== undefined) {
        doc.setIn(["model", "context_length"], selectedContext);
      } else if (originalContext !== undefined) {
        doc.deleteIn(["model", "context_length"]);
      }
    }
    const after = doc.toString();
    const backupAfter =
      backupBefore === undefined || !gatewaySelected
        ? JSON.stringify(
            gatewaySelected
              ? {
                  provider: null,
                  model: null,
                  context: originalContext ?? null,
                  legacy: true,
                }
              : {
                  provider:
                    scalarModel === undefined
                      ? (originalProvider ?? null)
                      : null,
                  model:
                    scalarModel === undefined ? (originalModel ?? null) : null,
                  context: originalContext ?? null,
                  ...(scalarModel === undefined ? {} : { scalarModel }),
                },
            null,
            2,
          ) + "\n"
        : backupBefore;
    return {
      changes: [
        ...change(backup, backupBefore, backupAfter),
        ...change(p, before, after),
      ],
      summary: [
        `Upsert providers.${GATEWAY_PROVIDER_ID} (${entry.api}, chat_completions) in ${p}; per-model context lengths come from gateway metadata.`,
        `Set Hermes model.provider to ${GATEWAY_PROVIDER_ID} and model.default to ${input.defaultModel}.`,
      ],
      afterApply: "Restart Hermes to use the selected default in new sessions.",
    };
  },
  unplan(input, files) {
    const p = hermesPath(input.home, input.platform);
    const before = files[p];
    if (before === undefined) {
      const backup = hermesBackupPath(input.home, input.platform);
      if (files[backup] !== undefined) {
        return {
          changes: [],
          summary: [
            `Cannot restore Hermes's previous model because ${p} does not exist; kept ${backup}.`,
          ],
          manualSteps: [
            `Restore or recreate ${p}, then remove the Agent Gateway configuration again.`,
          ],
        };
      }
      return {
        changes: [],
        summary: [`${p} does not exist; nothing to remove.`],
      };
    }
    const doc = parseDocument(before);
    if (
      doc.errors.length > 0 ||
      (doc.contents !== null && !isMap(doc.contents))
    ) {
      throw new Error(
        `Cannot safely remove Hermes's provider: ${p} must be a YAML mapping.`,
      );
    }
    const backup = hermesBackupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = hermesPrevious(backupBefore);
    const modelBlock = doc.getIn(["model"], true);
    if (modelBlock !== undefined && modelBlock !== null && !isMap(modelBlock)) {
      throw new Error(
        `Cannot safely remove Hermes's provider: model must be a mapping.`,
      );
    }
    const providersBlock = doc.getIn(["providers"], true);
    if (
      providersBlock !== undefined &&
      providersBlock !== null &&
      !isMap(providersBlock)
    ) {
      throw new Error(
        `Cannot safely remove Hermes's provider: providers must be a mapping.`,
      );
    }
    const currentProvider = doc.getIn(["model", "provider"]);
    const gatewaySelected =
      currentProvider === GATEWAY_PROVIDER_ID ||
      currentProvider === `custom:${GATEWAY_PROVIDER_ID}`;
    const hasGatewayProvider = doc.hasIn(["providers", GATEWAY_PROVIDER_ID]);
    if (!hasGatewayProvider && !gatewaySelected && !previous.found) {
      return {
        changes: [],
        summary: [`${p} has no gateway configuration; nothing to remove.`],
      };
    }
    if (hasGatewayProvider) {
      doc.deleteIn(["providers", GATEWAY_PROVIDER_ID]);
    }
    const providers = doc.get("providers");
    if (isMap(providers) && providers.items.length === 0) {
      doc.delete("providers");
    }
    if (previous.found && gatewaySelected) {
      if (previous.scalarModel !== undefined) {
        const model = new Scalar(previous.scalarModel);
        model.type = Scalar.QUOTE_DOUBLE;
        doc.set("model", model);
      } else {
        if (previous.provider === null) {
          doc.deleteIn(["model", "provider"]);
        } else {
          doc.setIn(["model", "provider"], previous.provider);
        }
        if (previous.model === null) {
          doc.deleteIn(["model", "default"]);
        } else {
          doc.setIn(["model", "default"], previous.model);
        }
        if (previous.legacy) {
          if (previous.context === null) {
            doc.deleteIn(["model", "context_length"]);
          } else {
            doc.setIn(["model", "context_length"], previous.context);
          }
        } else if (previous.context === null) {
          doc.deleteIn(["model", "context_length"]);
        } else {
          doc.setIn(["model", "context_length"], previous.context);
        }
        const modelBlock = doc.getIn(["model"], true);
        if (isMap(modelBlock) && modelBlock.items.length === 0) {
          doc.delete("model");
        }
      }
    } else if (gatewaySelected) {
      doc.deleteIn(["model", "provider"]);
      doc.deleteIn(["model", "default"]);
      const modelBlock = doc.getIn(["model"], true);
      if (isMap(modelBlock) && modelBlock.items.length === 0) {
        doc.delete("model");
      }
    }
    const after = doc.toString();
    return {
      changes: [
        ...change(p, before, after),
        ...change(backup, backupBefore, undefined),
      ],
      summary: [
        `Remove providers.${GATEWAY_PROVIDER_ID} and restore the previous global model in ${p}.`,
      ],
    };
  },
};
