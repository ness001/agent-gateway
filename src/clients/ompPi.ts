import {
  type FormattingOptions,
  type ParseError,
  applyEdits,
  modify,
  parse,
} from "jsonc-parser";
import * as path from "path";
import { isMap, parseDocument } from "yaml";

import { validContextWindow } from "./contextWindow";
import {
  type ClientAdapter,
  type ClientConfigInput,
  type ClientPlan,
  GATEWAY_PROVIDER_ID,
  type GatewayModel,
  PLACEHOLDER_API_KEY,
} from "./types";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function baseUrl(input: ClientConfigInput): string {
  return `${input.gatewayUrl.replace(/\/+$/, "")}/v1`;
}

function apiKey(input: ClientConfigInput): string {
  return input.apiKey || PLACEHOLDER_API_KEY;
}

function change(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
): ClientPlan["changes"] {
  return before === after ? [] : [{ path: filePath, before, after }];
}

// ---------------------------------------------------------------- omp

function ompDir(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".omp", "agent");
}

function ompConfigPaths(
  home: string,
  platform: NodeJS.Platform,
): { yml: string; yaml: string } {
  const dir = ompDir(home, platform);
  const p = pathApi(platform);
  return { yml: p.join(dir, "config.yml"), yaml: p.join(dir, "config.yaml") };
}

function ompPaths(
  home: string,
  platform: NodeJS.Platform,
): { yml: string; yaml: string } {
  const dir = ompDir(home, platform);
  const p = pathApi(platform);
  return { yml: p.join(dir, "models.yml"), yaml: p.join(dir, "models.yaml") };
}

/** models.yml wins; models.yaml is edited only when it is the sole file. */
function ompTarget(
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): string {
  const { yml, yaml } = ompPaths(input.home, input.platform);
  return files[yml] === undefined && files[yaml] !== undefined ? yaml : yml;
}

function ompConfigTarget(
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): string {
  const { yml, yaml } = ompConfigPaths(input.home, input.platform);
  return files[yml] === undefined && files[yaml] !== undefined ? yaml : yml;
}

function ompBackupPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(
    ompDir(home, platform),
    "agent-gateway-default.json",
  );
}

interface OmpPrevious {
  model: string | null;
  configExisted: boolean;
}

function ompPrevious(text: string | undefined): OmpPrevious | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("omp gateway default backup is invalid.");
  }
  const { model, configExisted } = value as Record<string, unknown>;
  if (
    (model !== null && typeof model !== "string") ||
    typeof configExisted !== "boolean"
  ) {
    throw new Error("omp gateway default backup is invalid.");
  }
  return { model, configExisted };
}

export const ompAdapter: ClientAdapter = {
  id: "omp",
  label: "Oh My Pi (omp)",
  discovery: "auto",
  caveat:
    "omp lists models from GET <gateway>/v1/models; project or session model roles can override the global default.",
  detectPaths(home, platform) {
    return [ompDir(home, platform)];
  },
  configPaths(home, platform) {
    const { yml, yaml } = ompPaths(home, platform);
    const config = ompConfigPaths(home, platform);
    return [yml, yaml, config.yml, config.yaml, ompBackupPath(home, platform)];
  },
  plan(input, files) {
    const target = ompTarget(input, files);
    const before = files[target];
    const doc = parseDocument(before ?? "");
    if (
      doc.errors.length > 0 ||
      (doc.contents !== null && !isMap(doc.contents))
    ) {
      throw new Error(
        `Cannot parse ${target}: ${doc.errors[0]?.message ?? "top level is not a mapping"}`,
      );
    }
    if (!isMap(doc.contents)) {
      doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
    }
    const entry = {
      baseUrl: baseUrl(input),
      apiKey: apiKey(input),
      api: "openai-responses",
      discovery: { type: "openai-models-list", injectV1: false },
    };
    const keys = ["providers", GATEWAY_PROVIDER_ID];
    if (!isMap(doc.getIn(keys, true))) {
      doc.setIn(keys, doc.createNode(entry));
    } else {
      // Update field by field so comments on the existing entry survive.
      doc.setIn([...keys, "baseUrl"], entry.baseUrl);
      doc.setIn([...keys, "apiKey"], entry.apiKey);
      doc.setIn([...keys, "api"], entry.api);
      if (!isMap(doc.getIn([...keys, "discovery"], true))) {
        doc.setIn([...keys, "discovery"], doc.createNode(entry.discovery));
      } else {
        doc.setIn([...keys, "discovery", "type"], entry.discovery.type);
        doc.setIn([...keys, "discovery", "injectV1"], false);
      }
    }
    const after = doc.toString();
    const config = ompConfigTarget(input, files);
    const configBefore = files[config];
    const configDoc = parseDocument(configBefore ?? "");
    if (
      configDoc.errors.length > 0 ||
      (configDoc.contents !== null && !isMap(configDoc.contents))
    ) {
      throw new Error(
        `Cannot safely edit ${config}: invalid YAML configuration.`,
      );
    }
    if (!isMap(configDoc.contents)) {
      configDoc.contents = configDoc.createNode(
        {},
      ) as unknown as typeof configDoc.contents;
    }
    const backup = ompBackupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = ompPrevious(backupBefore);
    const roles = configDoc.getIn(["modelRoles"], true);
    if (roles !== undefined && roles !== null && !isMap(roles)) {
      throw new Error(
        `Cannot safely edit ${config}: modelRoles must be a mapping.`,
      );
    }
    const original = configDoc.getIn(["modelRoles", "default"]);
    const gatewayModel =
      typeof original === "string" &&
      original.startsWith(`${GATEWAY_PROVIDER_ID}/`);
    if (
      original !== undefined &&
      original !== null &&
      typeof original !== "string"
    ) {
      throw new Error(
        `Cannot safely save omp's previous default in ${config}.`,
      );
    }
    configDoc.setIn(
      ["modelRoles", "default"],
      `${GATEWAY_PROVIDER_ID}/${input.defaultModel}`,
    );
    const configAfter = configDoc.toString();
    const refresh = previous !== undefined && !gatewayModel;
    const backupAfter =
      gatewayModel && previous === undefined
        ? undefined // Legacy gateway selection: the earlier default is unknown.
        : backupBefore === undefined || refresh
          ? JSON.stringify(
              {
                model: original ?? null,
                configExisted: refresh
                  ? previous!.configExisted
                  : configBefore !== undefined,
              },
              null,
              2,
            ) + "\n"
          : backupBefore;
    return {
      changes: [
        ...change(backup, backupBefore, backupAfter),
        ...change(target, before, after),
        ...change(config, configBefore, configAfter),
      ],
      summary: [
        `Add provider "${GATEWAY_PROVIDER_ID}" to ${target} (models discovered from ${baseUrl(input)}/models).`,
        `Set omp's global modelRoles.default to ${GATEWAY_PROVIDER_ID}/${input.defaultModel} in ${config}.`,
      ],
      afterApply: "Restart omp to use the selected default in new sessions.",
    };
  },
  unplan(input, files) {
    const target = ompTarget(input, files);
    const before = files[target];
    const summary: string[] = [];
    let after = before;
    if (before !== undefined) {
      const doc = parseDocument(before);
      if (
        doc.errors.length > 0 ||
        (doc.contents !== null && !isMap(doc.contents))
      ) {
        throw new Error(
          `Cannot safely remove omp's gateway provider: ${target} is not a YAML mapping.`,
        );
      }
      const providers = doc.getIn(["providers"], true);
      if (providers !== undefined && providers !== null && !isMap(providers)) {
        throw new Error(
          `Cannot safely remove omp's gateway provider: providers must be a mapping.`,
        );
      }
      if (doc.hasIn(["providers", GATEWAY_PROVIDER_ID])) {
        doc.deleteIn(["providers", GATEWAY_PROVIDER_ID]);
        const providers = doc.getIn(["providers"], true);
        if (isMap(providers) && providers.items.length === 0) {
          doc.deleteIn(["providers"]);
        }
        const root = doc.contents;
        const empty =
          isMap(root) &&
          root.items.length === 0 &&
          !doc.commentBefore &&
          !doc.comment;
        after = empty ? undefined : doc.toString();
        summary.push(
          `Remove provider "${GATEWAY_PROVIDER_ID}" from ${target}.`,
        );
      }
    }
    const config = ompConfigTarget(input, files);
    const configBefore = files[config];
    const backup = ompBackupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = ompPrevious(backupBefore);
    if (configBefore === undefined && previous?.configExisted) {
      throw new Error(
        `Cannot safely restore omp's previous default in ${config}: the config file is missing.`,
      );
    }
    let configAfter = configBefore;
    if (configBefore !== undefined && previous !== undefined) {
      const configDoc = parseDocument(configBefore);
      if (
        configDoc.errors.length > 0 ||
        (configDoc.contents !== null && !isMap(configDoc.contents))
      ) {
        throw new Error(
          `Cannot safely restore omp's previous default in ${config}: invalid YAML configuration.`,
        );
      }
      const roles = configDoc.getIn(["modelRoles"], true);
      if (roles !== undefined && roles !== null && !isMap(roles)) {
        throw new Error(
          `Cannot safely restore omp's previous default in ${config}: modelRoles must be a mapping.`,
        );
      }
      const current = configDoc.getIn(["modelRoles", "default"]);
      if (
        typeof current === "string" &&
        current.startsWith(`${GATEWAY_PROVIDER_ID}/`)
      ) {
        if (previous.model === null) {
          configDoc.deleteIn(["modelRoles", "default"]);
          const roles = configDoc.getIn(["modelRoles"], true);
          if (isMap(roles) && roles.items.length === 0) {
            configDoc.deleteIn(["modelRoles"]);
          }
        } else {
          configDoc.setIn(["modelRoles", "default"], previous.model);
        }
      }
      if (
        typeof current === "string" &&
        current.startsWith(`${GATEWAY_PROVIDER_ID}/`)
      ) {
        configAfter = configDoc.toString();
        if (
          !previous.configExisted &&
          (configAfter.trim() === "{}" || configAfter.trim() === "")
        ) {
          configAfter = undefined;
        }
        summary.push(`Restore omp's previous global default in ${config}.`);
      }
    } else if (configBefore !== undefined) {
      const configDoc = parseDocument(configBefore);
      if (
        configDoc.errors.length > 0 ||
        (configDoc.contents !== null && !isMap(configDoc.contents))
      ) {
        throw new Error(
          `Cannot safely remove omp's gateway provider: ${config} cannot be parsed.`,
        );
      }
      const roles = configDoc.getIn(["modelRoles"], true);
      if (roles !== undefined && roles !== null && !isMap(roles)) {
        throw new Error(
          `Cannot safely remove omp's gateway provider: modelRoles must be a mapping.`,
        );
      }
      const current = configDoc.getIn(["modelRoles", "default"]);
      if (
        typeof current === "string" &&
        current.startsWith(`${GATEWAY_PROVIDER_ID}/`)
      ) {
        configDoc.deleteIn(["modelRoles", "default"]);
        if (isMap(roles) && roles.items.length === 0) {
          configDoc.deleteIn(["modelRoles"]);
        }
        configAfter = configDoc.toString();
        summary.push(`Remove omp's legacy gateway default in ${config}.`);
      }
    }
    if (summary.length === 0) {
      summary.push(
        `${target} has no "${GATEWAY_PROVIDER_ID}" provider; nothing to remove.`,
      );
    }
    return {
      changes: [
        ...change(target, before, after),
        ...change(config, configBefore, configAfter),
        ...change(backup, backupBefore, undefined),
      ],
      summary,
    };
  },
};

// ---------------------------------------------------------------- pi

function piPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".pi", "agent", "models.json");
}

function piSettingsPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".pi", "agent", "settings.json");
}

function piBackupPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(
    home,
    ".pi",
    "agent",
    "agent-gateway-default.json",
  );
}

interface PiPrevious {
  provider: string | null;
  model: string | null;
  configExisted: boolean;
}

function piPrevious(text: string | undefined): PiPrevious | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi gateway default backup is invalid.");
  }
  const { provider, model, configExisted } = value as Record<string, unknown>;
  if (
    !(
      (provider === null || typeof provider === "string") &&
      (model === null || typeof model === "string") &&
      typeof configExisted === "boolean"
    )
  ) {
    throw new Error("Pi gateway default backup is invalid.");
  }
  return { provider, model, configExisted };
}

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

function piModels(models: GatewayModel[]): Record<string, unknown>[] {
  return models
    .filter(
      (m) =>
        m.supportsToolCalling !== false &&
        !m.id.startsWith("copilot-utility") &&
        !m.id.startsWith("copilot-dictation"),
    )
    .map((m) => {
      const entry: Record<string, unknown> = {
        id: m.id,
        name: m.displayName || m.id,
        reasoning: m.reasoning,
        input: m.inputModalities.filter((x) => x === "text" || x === "image"),
      };
      const contextWindow = validContextWindow(m.contextWindow);
      if (contextWindow !== undefined) {
        entry.contextWindow = contextWindow;
      }
      if (m.maxOutputTokens !== undefined) {
        entry.maxTokens = m.maxOutputTokens;
      }
      return entry;
    });
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

export const piAdapter: ClientAdapter = {
  id: "pi",
  label: "Pi coding agent",
  discovery: "static",
  caveat:
    "pi has no model discovery for custom providers; re-run to refresh the model list.",
  detectPaths(home, platform) {
    return [pathApi(platform).join(home, ".pi", "agent")];
  },
  configPaths(home, platform) {
    return [
      piPath(home, platform),
      piSettingsPath(home, platform),
      piBackupPath(home, platform),
    ];
  },
  plan(input, files) {
    const target = piPath(input.home, input.platform);
    const before = files[target];
    let text = before === undefined || before.trim() === "" ? "{}\n" : before;
    const root = parseJsonc(text, target);
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      throw new Error(
        `Cannot safely edit ${target}: models must be an object.`,
      );
    }
    const models = piModels(input.models);
    const key = ["providers", GATEWAY_PROVIDER_ID];
    text = edit(text, [...key, "baseUrl"], baseUrl(input));
    text = edit(text, [...key, "api"], "openai-responses");
    text = edit(text, [...key, "apiKey"], apiKey(input));
    text = edit(text, [...key, "models"], models);
    if (!models.some((m) => m.id === input.defaultModel)) {
      throw new Error(
        `Selected model ${input.defaultModel} is not available in Pi's model list.`,
      );
    }
    const settings = piSettingsPath(input.home, input.platform);
    const settingsBefore = files[settings];
    let settingsText = settingsBefore?.trim() ? settingsBefore : "{}\n";
    const settingsRoot = parseJsonc(settingsText, settings);
    if (
      !settingsRoot ||
      typeof settingsRoot !== "object" ||
      Array.isArray(settingsRoot)
    ) {
      throw new Error(
        `Cannot safely edit ${settings}: settings must be an object.`,
      );
    }
    if (settingsBefore !== undefined) {
      JSON.parse(settingsBefore);
    }
    const backup = piBackupPath(input.home, input.platform);
    const existingBackup = files[backup];
    const previous = piPrevious(existingBackup);
    const original = settingsRoot as Record<string, unknown>;
    const gatewaySelected = original.defaultProvider === GATEWAY_PROVIDER_ID;
    if (
      (original.defaultProvider !== undefined &&
        typeof original.defaultProvider !== "string") ||
      (original.defaultModel !== undefined &&
        typeof original.defaultModel !== "string")
    ) {
      throw new Error(
        `Cannot safely save Pi's previous default in ${settings}.`,
      );
    }
    const refresh = previous !== undefined && !gatewaySelected;
    const backupText =
      gatewaySelected && previous === undefined
        ? undefined // Legacy gateway selection: the earlier default is unknown.
        : existingBackup === undefined || refresh
          ? JSON.stringify(
              {
                provider: original.defaultProvider ?? null,
                model: original.defaultModel ?? null,
                configExisted: refresh
                  ? previous!.configExisted
                  : settingsBefore !== undefined,
              },
              null,
              2,
            ) + "\n"
          : existingBackup;
    settingsText = edit(settingsText, ["defaultProvider"], GATEWAY_PROVIDER_ID);
    settingsText = edit(settingsText, ["defaultModel"], input.defaultModel);
    return {
      changes: [
        ...change(backup, existingBackup, backupText),
        ...change(target, before, text),
        ...change(settings, settingsBefore, settingsText),
      ],
      summary: [
        `Write provider "${GATEWAY_PROVIDER_ID}" with ${models.length} model(s) to ${target}.`,
        `Set Pi's defaultProvider and defaultModel in ${settings}.`,
      ],
      afterApply: "Restart Pi to use the selected default in new sessions.",
    };
  },
  unplan(input, files) {
    const target = piPath(input.home, input.platform);
    const before = files[target];
    const root = before === undefined ? null : parseJsonc(before, target);
    if (
      before !== undefined &&
      (root === null || typeof root !== "object" || Array.isArray(root))
    ) {
      throw new Error(
        `Cannot safely remove Pi's provider: ${target} must be an object.`,
      );
    }
    const modelsConfig = root as { providers?: Record<string, unknown> } | null;
    if (
      modelsConfig?.providers !== undefined &&
      (modelsConfig.providers === null ||
        typeof modelsConfig.providers !== "object" ||
        Array.isArray(modelsConfig.providers))
    ) {
      throw new Error(
        `Cannot safely remove Pi's provider: providers must be an object.`,
      );
    }
    const settings = piSettingsPath(input.home, input.platform);
    const settingsBefore = files[settings];
    const backup = piBackupPath(input.home, input.platform);
    const backupBefore = files[backup];
    const previous = piPrevious(backupBefore);
    if (settingsBefore === undefined && previous?.configExisted) {
      throw new Error(
        `Cannot safely restore Pi's previous default in ${settings}: the settings file is missing.`,
      );
    }
    let settingsAfter = settingsBefore;
    if (settingsBefore !== undefined && previous) {
      const settingsRoot: unknown = JSON.parse(settingsBefore);
      if (
        settingsRoot === null ||
        typeof settingsRoot !== "object" ||
        Array.isArray(settingsRoot)
      ) {
        throw new Error(
          `Cannot safely restore Pi's previous default in ${settings}: settings must be an object.`,
        );
      }
      let updated = settingsBefore;
      const currentDefault = (settingsRoot as Record<string, unknown>)
        .defaultProvider;
      if (currentDefault !== undefined && typeof currentDefault !== "string") {
        throw new Error(
          `Cannot safely restore Pi's previous default in ${settings}: defaultProvider must be a string.`,
        );
      }
      if (currentDefault === GATEWAY_PROVIDER_ID) {
        updated = edit(
          updated,
          ["defaultProvider"],
          previous.provider ?? undefined,
        );
        updated = edit(updated, ["defaultModel"], previous.model ?? undefined);
      }
      settingsAfter =
        !previous.configExisted &&
        Object.keys(JSON.parse(updated) as object).length === 0
          ? undefined
          : updated;
    } else if (settingsBefore !== undefined) {
      const settingsRoot: unknown = JSON.parse(settingsBefore);
      if (
        settingsRoot === null ||
        typeof settingsRoot !== "object" ||
        Array.isArray(settingsRoot)
      ) {
        throw new Error(
          `Cannot safely remove Pi's provider: ${settings} must be an object.`,
        );
      }
      const currentDefault = (settingsRoot as Record<string, unknown>)
        .defaultProvider;
      if (currentDefault !== undefined && typeof currentDefault !== "string") {
        throw new Error(
          `Cannot safely remove Pi's provider: ${settings} defaultProvider must be a string.`,
        );
      }
      if (currentDefault === GATEWAY_PROVIDER_ID) {
        settingsAfter = edit(settingsBefore, ["defaultProvider"], undefined);
        settingsAfter = edit(settingsAfter, ["defaultModel"], undefined);
      }
    }
    if (
      !modelsConfig?.providers ||
      !(GATEWAY_PROVIDER_ID in modelsConfig.providers)
    ) {
      return {
        changes: [
          ...change(settings, settingsBefore, settingsAfter),
          ...change(backup, backupBefore, undefined),
        ],
        summary: [
          `${target} has no "${GATEWAY_PROVIDER_ID}" provider; restored any managed Pi default.`,
        ],
      };
    }
    let text = edit(before!, ["providers", GATEWAY_PROVIDER_ID], undefined);
    const rest = parseJsonc(text, target) as Record<string, unknown>;
    if (rest.providers && Object.keys(rest.providers).length === 0) {
      text = edit(text, ["providers"], undefined);
    }
    const after =
      Object.keys(parseJsonc(text, target) as object).length === 0 &&
      !/\/[/*]/.test(text)
        ? undefined
        : text;
    return {
      changes: [
        ...change(target, before, after),
        ...change(settings, settingsBefore, settingsAfter),
        ...change(backup, backupBefore, undefined),
      ],
      summary: [
        `Remove provider "${GATEWAY_PROVIDER_ID}" and restore Pi's previous default.`,
      ],
    };
  },
};
