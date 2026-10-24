import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { CatalogEntry } from "../gateway/types";
import { CONFIG_SECTION, DEFAULT_CONFIG } from "../utils/config";
import { editModelMapping, initializeModelMappings } from "./modelMapping";

export interface FallbackModelItem {
  label: string;
  action?: "initializeMappings" | "editMapping";
  /** Model ID to save; "" clears the setting. */
  id: string;
  description?: string;
  detail?: string;
}

/**
 * Items of the Set Fallback Model picker: "No fallback", AI initialization, then the user's own
 * local and remote non-alias models sorted by ID. The current fallback is marked with
 * its source.
 */
export function fallbackModelItems(
  models: readonly (Pick<CatalogEntry, "id" | "displayName"> &
    Partial<Pick<CatalogEntry, "remote" | "isAlias">>)[],
  current: { id: string | null; source: "setting" | null },
  aliases: Record<string, string> = {},
): FallbackModelItem[] {
  const mark = (id: string): string | undefined =>
    current.id === id ? `current (${current.source})` : undefined;
  return [
    {
      label: "No fallback",
      id: "",
      description: current.source === "setting" ? undefined : "current",
    },
    {
      label: "$(sparkle) Initialize model mappings with AI…",
      id: "",
      action: "initializeMappings",
      description: "Review suggestions for agent default models",
    },
    ...Object.entries({ ...DEFAULT_CONFIG.modelAliases, ...aliases })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([source, target]): FallbackModelItem => ({
          label: `$(edit) Mapping: ${source}`,
          id: source,
          action: "editMapping",
          description: target || "(empty — no mapping)",
          detail:
            "Choose a different target or clear this mapping. Does not change the fallback.",
        }),
      ),
    ...models
      .filter((m) => !m.isAlias)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => ({
        label: m.id,
        id: m.id,
        description: mark(m.id),
        detail:
          m.displayName && m.displayName !== m.id ? m.displayName : undefined,
      })),
  ];
}

/** Picks the model used for unknown model names; read per request, no restart. */
export async function setFallbackModel(
  gw: Pick<Gateway, "nativeModels" | "health">,
): Promise<void> {
  const models = gw.nativeModels();
  const aliases = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<Record<string, string>>("modelAliases", {});
  const h = gw.health();
  const picked = await vscode.window.showQuickPick(
    fallbackModelItems(
      models,
      {
        id: h.fallbackModel,
        source: h.fallbackModelSource,
      },
      aliases,
    ),
    {
      title: "Fallback model for unknown model names",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  if (picked.action === "initializeMappings") {
    await initializeModelMappings(gw);
    return;
  }
  if (picked.action === "editMapping") {
    await editModelMapping(gw, picked.id);
    return;
  }
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(
      "fallbackModel",
      picked.id === "" ? undefined : picked.id,
      vscode.ConfigurationTarget.Global,
    );
  const now = picked.id;
  void vscode.window.showInformationMessage(
    now
      ? `Fallback model: ${now}. Agents asking for a model you don't have now use it.`
      : "Fallback model: none. Agents asking for a model you don't have get an error.",
  );
}
