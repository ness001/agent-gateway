import * as os from "node:os";
import * as vscode from "vscode";

import { applyPlan, loadFiles } from "../clients/apply";
import { codexAdapter, planCodexWebSearch } from "../clients/codex";
import {
  WEB_SEARCH_ENGINES,
  type WebSearchEngineInfo,
} from "../protocol/hosted/catalog";
import { CONFIG_SECTION, readConfiguration } from "../utils/config";
import { webSearchApiKeySecretKey } from "../utils/constant";
import { logger } from "../utils/logger";

export function engineCapabilityText(engine: WebSearchEngineInfo): string {
  const search = engine.anonymous
    ? "search works without a key (rate-limited)"
    : "search requires an API key";
  const fetch = engine.fetchAnonymous
    ? "URL fetch works without a key"
    : "URL fetch requires an API key";
  return `${search}; ${fetch}.`;
}

/** QuickPick items for the engine picker; `current` is the configured provider id. */
export function webSearchEngineItems(
  current: string,
  engines: readonly WebSearchEngineInfo[] = WEB_SEARCH_ENGINES,
): { label: string; id: string; description?: string; detail: string }[] {
  return [
    {
      label: "Off",
      id: "none",
      description: current === "none" ? "current" : undefined,
      detail:
        "Web-search and URL-fetch requests fail and no search service is contacted.",
    },
    ...engines.map((engine) => ({
      label: engine.label,
      id: engine.id,
      description: current === engine.id ? "current" : undefined,
      detail: `${engineCapabilityText(engine)}${engine.anonymous ? " A key raises the limits." : ""}`,
    })),
  ];
}

export async function setWebSearchEngine(
  context: vscode.ExtensionContext,
): Promise<void> {
  const current = readConfiguration().webSearch.provider;
  const items = webSearchEngineItems(current);
  const picked = await vscode.window.showQuickPick(items, {
    title: "Web Search and Fetch: engine",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  const engine = WEB_SEARCH_ENGINES.find((e) => e.id === picked.id);
  if (engine) {
    const secretKey = webSearchApiKeySecretKey(engine.id);
    const stored = Boolean(await context.secrets.get(secretKey));
    const value = await vscode.window.showInputBox({
      title: `${engine.label} API key`,
      prompt: engine.anonymous
        ? `${engine.keyHint}. Leave empty to use the anonymous endpoint${stored ? " (removes the stored key)" : ""}. Get a key: ${engine.signupUrl}`
        : `${engine.keyHint} (required). Get a key: ${engine.signupUrl}`,
      placeHolder: stored
        ? "A key is stored; leave empty to remove it"
        : undefined,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    const key = value.trim();
    if (!key && !engine.anonymous) {
      void vscode.window.showWarningMessage(
        `${engine.label} has no anonymous endpoint, so it needs an API key. Web search was not changed.`,
      );
      return;
    }
    if (key) {
      await context.secrets.store(secretKey, key);
    } else {
      await context.secrets.delete(secretKey);
    }
  }
  // Setting the provider restarts the gateway through the configuration listener.
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update("webSearch.provider", picked.id, vscode.ConfigurationTarget.Global);
  const mode = !engine
    ? "off"
    : (await context.secrets.get(webSearchApiKeySecretKey(engine.id)))
      ? `${engine.label} with your API key`
      : `${engine.label} anonymous (rate-limited)`;
  logger.info(`Web search engine set: ${mode}.`);
  void vscode.window.showInformationMessage(`Web search: ${mode}.`);
  await syncCodexWebSearch(Boolean(engine));
}

/**
 * Codex only sends a live web_search tool when its own `web_search` setting is
 * "live"; its default ("cached") reaches the gateway as no search. Offer to
 * switch it whenever the gateway engine is turned on or off.
 */
async function syncCodexWebSearch(enable: boolean): Promise<void> {
  const home = os.homedir();
  const files = await loadFiles(
    codexAdapter.configPaths(home, process.platform),
  );
  const plan = planCodexWebSearch(home, process.platform, files, enable);
  if (plan.changes.length === 0) {
    return;
  }
  const change = plan.changes[0];
  const question = enable
    ? 'Codex only uses live web search when its "web_search" setting is "live". Set it in ~/.codex/config.toml now?'
    : 'Restore the Codex "web_search" setting that was changed when web search was turned on?';
  const choice = await vscode.window.showInformationMessage(
    question,
    { modal: true, detail: `${plan.summary.join("\n")}\nA backup is created.` },
    "Apply",
    "Show diff",
  );
  if (choice === "Show diff") {
    const left = vscode.Uri.file(change.path);
    const right = await vscode.workspace.openTextDocument({
      content: change.after ?? "",
      language: "toml",
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right.uri,
      "Codex config.toml: web_search",
    );
    return syncCodexWebSearch(enable);
  }
  if (choice !== "Apply") {
    return;
  }
  try {
    const backups = await applyPlan(plan);
    logger.info(
      `Codex web_search ${enable ? "set to live" : "restored"}; backup: ${backups.join(", ") || "none"}.`,
    );
    void vscode.window.showInformationMessage(
      `Codex web search ${enable ? 'set to "live"' : "restored"}. Restart Codex to pick it up.`,
    );
  } catch (error) {
    logger.error(
      `Updating Codex web_search failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    void vscode.window.showErrorMessage(
      "Could not update ~/.codex/config.toml; see the gateway log.",
    );
  }
}
