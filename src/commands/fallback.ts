import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { CatalogEntry } from "../gateway/types";
import { CONFIG_SECTION } from "../utils/config";
import { initializeModelMappings } from "./modelMapping";

export interface FallbackModelItem {
  label: string;
  action?: "initializeMappings";
  /** Model ID to save; "" clears the setting. */
  id: string;
  description?: string;
  detail?: string;
}

/**
 * Items of the Set Fallback Model picker: "Use default", AI initialization, then the user's own
 * local, non-alias models sorted by ID. The current fallback is marked with
 * its source.
 */
export function fallbackModelItems(
  models: readonly (Pick<CatalogEntry, "id" | "displayName"> &
    Partial<Pick<CatalogEntry, "remote" | "isAlias">>)[],
  current: { id: string | null; source: "setting" | "default" | null },
): FallbackModelItem[] {
  const mark = (id: string): string | undefined =>
    current.id === id ? `current (${current.source})` : undefined;
  return [
    {
      label: "Use default (gpt-6-astra if available)",
      id: "",
      description: current.source === "setting" ? undefined : "current",
    },
    {
      label: "$(sparkle) Initialize model mappings with AI…",
      id: "",
      action: "initializeMappings",
      description: "Review suggestions for agent default models",
    },
    ...models
      .filter((m) => m.remote === undefined && !m.isAlias)
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
  if (!models.some((m) => m.remote === undefined)) {
    void vscode.window.showErrorMessage("The gateway has no models yet.");
    return;
  }
  const h = gw.health();
  const picked = await vscode.window.showQuickPick(
    fallbackModelItems(models, {
      id: h.fallbackModel,
      source: h.fallbackModelSource,
    }),
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
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(
      "fallbackModel",
      picked.id === "" ? undefined : picked.id,
      vscode.ConfigurationTarget.Global,
    );
  const now = picked.id || gw.health().fallbackModel;
  void vscode.window.showInformationMessage(
    now
      ? `Fallback model: ${now}. Agents asking for a model you don't have now use it.`
      : "Fallback model: none. Agents asking for a model you don't have get an error.",
  );
}
