import * as path from "path";
import { YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";

import { validContextWindow } from "./contextWindow";
import {
  ClientAdapter,
  ClientConfigInput,
  ClientPlan,
  GATEWAY_PROVIDER_ID,
  GATEWAY_PROVIDER_NAME,
  GatewayModel,
  PLACEHOLDER_API_KEY,
} from "./types";

// DeepSeek Harness (`dsh`, npm @deepseek-ai/dsh) composes each profile from
// patch layers; $DSH_HOME/cordis.patch.yml applies to every profile. We add a
// route to the pi-ai multi-provider adapter (plugin id `llm-pi-ai`) and point
// the default model (plugin id `agent-default-model`) at it. Checked against
// dsh 0.2.1-alpha.2 on Windows, 2026-10-20.

const PI_AI_ID = "llm-pi-ai";
const DEFAULT_MODEL_ID = "agent-default-model";
const PREV_MARKER = "# agent-gateway:previous-default-model=";

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** DSH_HOME when set, else ~/.dsh. */
export function dshHome(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.DSH_HOME?.trim();
  return override || pathFor(platform).join(home, ".dsh");
}

function patchPath(home: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(dshHome(home, platform), "cordis.patch.yml");
}

function agentModels(models: GatewayModel[]): GatewayModel[] {
  return models.filter((m) => m.supportsToolCalling !== false);
}

function findEntry(seq: YAMLSeq, id: string): YAMLMap | undefined {
  return seq.items.find(
    (item): item is YAMLMap => isMap(item) && item.get("id") === id,
  );
}

function readMarker(text: string): { found: boolean; value: unknown } {
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

function load(text: string | undefined): {
  seq?: YAMLSeq;
  doc: ReturnType<typeof parseDocument>;
  error?: string;
} {
  const body = stripMarker(text ?? "");
  const doc = parseDocument(body.trim() === "" ? "[]\n" : body);
  if (doc.errors.length > 0) {
    return { doc, error: doc.errors[0].message };
  }
  if (!isSeq(doc.contents)) {
    return { doc, error: "top level is not a list of patch entries" };
  }
  if (doc.contents.items.length === 0) {
    // dsh seeds patch files with `[]`; write entries in block style.
    doc.contents.flow = false;
  }
  return { doc, seq: doc.contents };
}

function route(input: ClientConfigInput) {
  return {
    displayName: GATEWAY_PROVIDER_NAME,
    api: "anthropic-messages",
    baseURL: input.gatewayUrl,
    // A literal header keeps the secret out of the environment; pi-ai sends
    // it as-is (apiKeyEnv would need a variable set in every shell).
    headers: { "x-api-key": input.apiKey || PLACEHOLDER_API_KEY },
    models: agentModels(input.models).map((m) => {
      const entry: Record<string, unknown> = {
        id: m.id,
        name: m.displayName || m.id,
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
    }),
  };
}

export const deepseekHarnessAdapter: ClientAdapter = {
  id: "deepseek-harness",
  label: "DeepSeek Harness",
  discovery: "static",
  detectPaths: (home, platform) => [dshHome(home, platform)],
  configPaths: (home, platform) => [patchPath(home, platform)],
  plan(input, files) {
    const p = patchPath(input.home, input.platform);
    const before = files[p];
    const { doc, seq, error } = load(before);
    if (!seq) {
      return {
        changes: [],
        summary: [`Cannot safely edit ${p}: ${error}.`],
        manualSteps: [
          `Add '${PI_AI_ID}' providers.${GATEWAY_PROVIDER_ID} and '${DEFAULT_MODEL_ID}' entries to ${p} by hand.`,
        ],
      };
    }
    const r = route(input);
    let pi = findEntry(seq, PI_AI_ID);
    if (!pi) {
      pi = doc.createNode({ id: PI_AI_ID }) as YAMLMap;
      seq.add(pi);
    }
    pi.setIn(["config", "providers", GATEWAY_PROVIDER_ID], doc.createNode(r));

    let dm = findEntry(seq, DEFAULT_MODEL_ID);
    let prev: unknown = null;
    if (dm) {
      const cfg = dm.get("config", true);
      prev = isMap(cfg) ? cfg.toJSON() : null;
    } else {
      dm = doc.createNode({ id: DEFAULT_MODEL_ID }) as YAMLMap;
      seq.add(dm);
    }
    const alreadyOurs =
      isMap(dm.get("config")) &&
      dm.getIn(["config", "provider"]) === GATEWAY_PROVIDER_ID;
    dm.setIn(["config", "provider"], GATEWAY_PROVIDER_ID);
    dm.setIn(["config", "model"], input.defaultModel);

    const marker = readMarker(before ?? "");
    let after = doc.toString();
    if (marker.found) {
      after = PREV_MARKER + JSON.stringify(marker.value) + "\n" + after;
    } else if (!alreadyOurs) {
      after = PREV_MARKER + JSON.stringify(prev) + "\n" + after;
    }
    return {
      changes: after === before ? [] : [{ path: p, before, after }],
      summary: [
        `Write ${r.models.length} models to ${PI_AI_ID} providers.${GATEWAY_PROVIDER_ID} (anthropic-messages) in ${p}.`,
        `Set ${DEFAULT_MODEL_ID} to ${GATEWAY_PROVIDER_ID}/${input.defaultModel} for every dsh profile.`,
      ],
      afterApply: "Restart running dsh sessions to load the new patch layer.",
    };
  },
  unplan(input, files) {
    const p = patchPath(input.home, input.platform);
    const before = files[p];
    if (before === undefined) {
      return {
        changes: [],
        summary: [`${p} does not exist; nothing to remove.`],
      };
    }
    const { doc, seq } = load(before);
    if (!seq) {
      return {
        changes: [],
        summary: [`Cannot parse ${p}; nothing removed.`],
      };
    }
    const summary: string[] = [];
    const pi = findEntry(seq, PI_AI_ID);
    if (pi?.hasIn(["config", "providers", GATEWAY_PROVIDER_ID])) {
      pi.deleteIn(["config", "providers", GATEWAY_PROVIDER_ID]);
      summary.push(`Remove ${PI_AI_ID} providers.${GATEWAY_PROVIDER_ID}.`);
      pruneEmpty(seq, pi, ["config", "providers"]);
    }
    const dm = findEntry(seq, DEFAULT_MODEL_ID);
    if (dm?.getIn(["config", "provider"]) === GATEWAY_PROVIDER_ID) {
      const marker = readMarker(before);
      const prev = marker.value;
      if (prev && typeof prev === "object") {
        dm.set("config", doc.createNode(prev));
        summary.push(`Restore the previous ${DEFAULT_MODEL_ID} config.`);
      } else {
        dm.delete("config");
        summary.push(`Remove the ${DEFAULT_MODEL_ID} override.`);
        if (dm.items.length === 1) {
          seq.items.splice(seq.items.indexOf(dm), 1);
        }
      }
    }
    const after = doc.toString();
    return {
      changes: after === before ? [] : [{ path: p, before, after }],
      summary: summary.length ? summary : ["Nothing to remove."],
    };
  },
};

/** Drop empty maps along keyPath and the entry itself when only `id` remains. */
function pruneEmpty(seq: YAMLSeq, entry: YAMLMap, keyPath: string[]): void {
  for (let i = keyPath.length; i > 0; i--) {
    const node = entry.getIn(keyPath.slice(0, i));
    if (isMap(node) && node.items.length === 0) {
      entry.deleteIn(keyPath.slice(0, i));
    }
  }
  if (entry.items.length === 1) {
    seq.items.splice(seq.items.indexOf(entry), 1);
  }
}
