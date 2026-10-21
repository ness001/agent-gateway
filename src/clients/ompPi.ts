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

export const ompAdapter: ClientAdapter = {
  id: "omp",
  label: "Oh My Pi (omp)",
  discovery: "auto",
  caveat:
    "omp lists models from GET <gateway>/v1/models (openai-models-list discovery); select one with /model.",
  detectPaths(home, platform) {
    return [ompDir(home, platform)];
  },
  configPaths(home, platform) {
    const { yml, yaml } = ompPaths(home, platform);
    return [yml, yaml];
  },
  plan(input, files) {
    const target = ompTarget(input, files);
    const before = files[target];
    const doc = parseDocument(before ?? "");
    if (doc.errors.length > 0) {
      throw new Error(`Cannot parse ${target}: ${doc.errors[0].message}`);
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
    return {
      changes: change(target, before, after),
      summary: [
        `Add provider "${GATEWAY_PROVIDER_ID}" to ${target} (models discovered from ${baseUrl(input)}/models).`,
        `omp's default model is not changed; pick "${GATEWAY_PROVIDER_ID}/${input.defaultModel}" with /model in omp.`,
      ],
      afterApply: `Restart omp, then run /model and choose ${GATEWAY_PROVIDER_ID}/${input.defaultModel}.`,
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
        doc.errors.length === 0 &&
        doc.hasIn(["providers", GATEWAY_PROVIDER_ID])
      ) {
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
    if (summary.length === 0) {
      summary.push(
        `${target} has no "${GATEWAY_PROVIDER_ID}" provider; nothing to remove.`,
      );
    }
    return { changes: change(target, before, after), summary };
  },
};

// ---------------------------------------------------------------- pi

function piPath(home: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(home, ".pi", "agent", "models.json");
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
    return [piPath(home, platform)];
  },
  plan(input, files) {
    const target = piPath(input.home, input.platform);
    const before = files[target];
    let text = before === undefined || before.trim() === "" ? "{}\n" : before;
    const root = parseJsonc(text, target);
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      text = "{}\n";
    }
    const models = piModels(input.models);
    const key = ["providers", GATEWAY_PROVIDER_ID];
    text = edit(text, [...key, "baseUrl"], baseUrl(input));
    text = edit(text, [...key, "api"], "openai-responses");
    text = edit(text, [...key, "apiKey"], apiKey(input));
    text = edit(text, [...key, "models"], models);
    return {
      changes: change(target, before, text),
      summary: [
        `Write provider "${GATEWAY_PROVIDER_ID}" with ${models.length} model(s) to ${target}.`,
        `pi's default model is not changed; pick "${GATEWAY_PROVIDER_ID}/${input.defaultModel}" with /model in pi.`,
      ],
      afterApply: `Open /model in pi and choose ${input.defaultModel} (${GATEWAY_PROVIDER_ID}).`,
    };
  },
  unplan(input, files) {
    const target = piPath(input.home, input.platform);
    const before = files[target];
    if (before === undefined) {
      return {
        changes: [],
        summary: [`${target} does not exist; nothing to remove.`],
      };
    }
    const root = parseJsonc(before, target) as {
      providers?: Record<string, unknown>;
    } | null;
    if (!root?.providers || !(GATEWAY_PROVIDER_ID in root.providers)) {
      return {
        changes: [],
        summary: [
          `${target} has no "${GATEWAY_PROVIDER_ID}" provider; nothing to remove.`,
        ],
      };
    }
    let text = edit(before, ["providers", GATEWAY_PROVIDER_ID], undefined);
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
      changes: change(target, before, after),
      summary: [`Remove provider "${GATEWAY_PROVIDER_ID}" from ${target}.`],
    };
  },
};
