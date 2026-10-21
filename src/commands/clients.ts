import { existsSync } from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";

import { applyPlan, loadFiles, redactSecrets } from "../clients/apply";
import { ALL_CLIENT_ADAPTERS, DISCOVERY_LABELS } from "../clients/index";
import type {
  ClientAdapter,
  ClientConfigInput,
  ClientPlan,
  GatewayModel,
} from "../clients/types";
import type { Gateway } from "../gateway/gateway";
import type { CatalogEntry } from "../gateway/types";
import { LLM_API_KEY_SECRET_KEY } from "../utils/constant";
import { logger } from "../utils/logger";

const LAST_MODEL_KEY = "agentGateway.configureClients.defaultModel";

export function toGatewayModel(e: CatalogEntry): GatewayModel {
  return {
    id: e.id,
    displayName: e.displayName,
    contextWindow: e.contextWindow,
    inputModalities: [...e.inputModalities],
    supportsToolCalling: e.supportsToolCalling,
    reasoning: e.supportedReasoningLevels.length > 0,
  };
}

export type ClientConfigState = "up to date" | "configured" | "not configured";

/**
 * Whether the gateway is set up in a client's config files. plan() producing no
 * file change means the config already matches (up to date); otherwise
 * unplan() producing a change means our entries are present (configured, but
 * stale: different port, key or model list). Both are pure, so this only
 * costs reading the config files once.
 */
export function clientConfigState(
  adapter: ClientAdapter,
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): ClientConfigState {
  const changes = (p: ClientPlan) =>
    p.changes.filter((c) => c.before !== c.after).length;
  if (
    adapter.discovery !== "manual" &&
    changes(adapter.plan(input, files)) === 0
  ) {
    return "up to date";
  }
  return changes(adapter.unplan(input, files)) > 0
    ? "configured"
    : "not configured";
}

export function clientItemDescription(
  installed: boolean,
  discovery: ClientAdapter["discovery"],
  state: ClientConfigState | undefined,
): string {
  return [
    state ? (state === "configured" ? "configured (outdated)" : state) : "",
    installed ? "installed" : "",
    DISCOVERY_LABELS[discovery],
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Pre-ticked in the agent picker: only agents the gateway is already set up
 * in, so OK updates or removes them. Installed agents that were never set up
 * start unticked; the user opts in.
 */
export function pickedByDefault(state: ClientConfigState | undefined): boolean {
  return state === "configured" || state === "up to date";
}

export type ClientAction = "configure" | "updateModels" | "unconfigure";

export const CLIENT_ACTION_LABELS: Record<ClientAction, string> = {
  configure: "Configure / update",
  updateModels: "Update model list",
  unconfigure: "Remove gateway",
};

/** Actions offered for the picked clients ("Update model list" only for static-list clients). */
export function clientActions(adapters: ClientAdapter[]): ClientAction[] {
  return adapters.length > 0 && adapters.every((a) => a.discovery === "static")
    ? ["configure", "updateModels", "unconfigure"]
    : ["configure", "unconfigure"];
}

async function pickClients(
  home: string,
  verb: string,
  input: ClientConfigInput,
): Promise<ClientAdapter[] | undefined> {
  const items = await Promise.all(
    ALL_CLIENT_ADAPTERS.map(async (a) => {
      const installed = a
        .detectPaths(home, process.platform)
        .some((p) => existsSync(p));
      let state: ClientConfigState | undefined;
      try {
        const files = await loadFiles(a.configPaths(home, process.platform));
        state = clientConfigState(a, input, files);
      } catch {
        state = undefined;
      }
      return {
        label: a.label,
        description: clientItemDescription(installed, a.discovery, state),
        detail: a.caveat,
        picked: pickedByDefault(state),
        adapter: a,
      };
    }),
  );
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `${verb}: select coding agents`,
  });
  return picked?.length ? picked.map((p) => p.adapter) : undefined;
}

async function pickDefaultModel(
  context: vscode.ExtensionContext,
  models: GatewayModel[],
): Promise<string | undefined> {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const previous = context.globalState.get<string>(LAST_MODEL_KEY);
  const preferred =
    sorted.find((m) => m.id === previous) ??
    sorted.find((m) => m.id.startsWith("claude-")) ??
    sorted[0];
  const items = [preferred, ...sorted.filter((m) => m !== preferred)].map(
    (m) => ({ label: m.id, description: m.displayName }),
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: "Default model for the selected agents",
  });
  if (picked) {
    await context.globalState.update(LAST_MODEL_KEY, picked.label);
  }
  return picked?.label;
}

async function showDiffs(
  plans: [ClientAdapter, ClientPlan][],
  secrets: (string | undefined)[],
): Promise<void> {
  for (const [adapter, plan] of plans) {
    for (const c of plan.changes) {
      if (c.before === c.after) {
        continue;
      }
      const left = await vscode.workspace.openTextDocument({
        content: redactSecrets(c.before ?? "", secrets),
      });
      const right = await vscode.workspace.openTextDocument({
        content: redactSecrets(c.after ?? "", secrets),
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        left.uri,
        right.uri,
        `${adapter.label}: ${c.path}${c.after === undefined ? " (delete)" : ""}`,
      );
    }
  }
}

export async function runClientConfiguration(
  context: vscode.ExtensionContext,
  gw: Gateway,
  requested?: "configure" | "unconfigure",
): Promise<void> {
  const port = gw.port;
  if (port === undefined) {
    void vscode.window.showErrorMessage(
      "The gateway is not listening; start it before configuring coding agents.",
    );
    return;
  }
  const models = gw.nativeModels().map(toGatewayModel);
  if (requested === "configure" && models.length === 0) {
    void vscode.window.showErrorMessage("The gateway has no models yet.");
    return;
  }
  const home = os.homedir();
  const previous = context.globalState.get<string>(LAST_MODEL_KEY);
  const input: ClientConfigInput = {
    gatewayUrl: `http://127.0.0.1:${port}`,
    apiKey: (await context.secrets.get(LLM_API_KEY_SECRET_KEY)) || undefined,
    models,
    defaultModel:
      models.find((m) => m.id === previous)?.id ?? models[0]?.id ?? "",
    home,
    platform: process.platform,
  };
  const adapters = await pickClients(
    home,
    requested === "unconfigure"
      ? "Remove Gateway From Coding Agents"
      : "Configure Coding Agents",
    input,
  );
  if (!adapters) {
    return;
  }
  let mode = requested;
  if (!mode) {
    const action = await vscode.window.showQuickPick(
      clientActions(adapters).map((id) => ({
        label: CLIENT_ACTION_LABELS[id],
        id,
      })),
      { title: `Coding agents: ${adapters.map((x) => x.label).join(", ")}` },
    );
    if (!action) {
      return;
    }
    mode = action.id === "unconfigure" ? "unconfigure" : "configure";
  }
  if (mode === "configure" && models.length === 0) {
    void vscode.window.showErrorMessage("The gateway has no models yet.");
    return;
  }
  const verb =
    mode === "configure"
      ? "Configure Coding Agents"
      : "Remove Gateway From Coding Agents";
  if (mode === "configure") {
    const picked = await pickDefaultModel(context, models);
    if (!picked) {
      return;
    }
    input.defaultModel = picked;
  }

  const plans: [ClientAdapter, ClientPlan][] = [];
  const failures: string[] = [];
  for (const a of adapters) {
    try {
      const files = await loadFiles(a.configPaths(home, process.platform));
      plans.push([
        a,
        mode === "configure" ? a.plan(input, files) : a.unplan(input, files),
      ]);
    } catch (err) {
      failures.push(`${a.label}: ${(err as Error).message}`);
    }
  }
  const changed = plans.flatMap(([, p]) =>
    p.changes.filter((c) => c.before !== c.after),
  );
  // Only the agents whose files change; details are in Show diff.
  const preview = [
    ...plans
      .filter(([, p]) => p.changes.some((c) => c.before !== c.after))
      .map(([a]) => `- ${a.label}`),
    ...failures.map((f) => `Skipped ${f}`),
  ].join("\n");

  let backups: string[] = [];
  if (changed.length > 0) {
    const apply = `Apply changes to ${changed.length} file${changed.length === 1 ? "" : "s"} (backups are created)`;
    let choice = await vscode.window.showInformationMessage(
      verb,
      { modal: true, detail: preview },
      apply,
      "Show diff",
    );
    if (choice === "Show diff") {
      await showDiffs(plans, [input.apiKey]);
      // A picker that stays open while the diff editors are scrolled
      // (a modal blocks them; a notification hides itself).
      const pick = await vscode.window.showQuickPick(
        [
          { label: apply, apply: true },
          { label: "Cancel", apply: false },
        ],
        {
          title: `${verb}: review the diffs, then apply or cancel`,
          ignoreFocusOut: true,
        },
      );
      choice = pick?.apply ? apply : undefined;
    }
    if (choice !== apply) {
      return;
    }
    try {
      for (const [, p] of plans) {
        backups.push(...(await applyPlan(p)));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Applying changes failed: ${(err as Error).message}`,
      );
      return;
    }
  }

  const clipboard = plans
    .map(([, p]) => p.clipboard)
    .filter((c): c is string => !!c)
    .join("\n\n");
  if (clipboard) {
    await vscode.env.clipboard.writeText(clipboard);
  }
  const md = [
    `# ${verb}`,
    "",
    ...plans.flatMap(([a, p]) => [
      `## ${a.label}`,
      "",
      ...p.summary.map((s) => `- ${s}`),
      ...(p.manualSteps?.length
        ? [
            "",
            "Manual steps:",
            "",
            ...p.manualSteps.map((s, i) => `${i + 1}. ${s}`),
          ]
        : []),
      ...(p.afterApply && mode === "configure"
        ? ["", `**Next:** ${p.afterApply}`]
        : []),
      "",
    ]),
    ...(failures.length
      ? ["## Skipped", "", ...failures.map((f) => `- ${f}`), ""]
      : []),
    ...(backups.length
      ? ["## Backups", "", ...backups.map((b) => `- ${b}`), ""]
      : []),
    ...(clipboard
      ? ["Manual-step values were copied to the clipboard.", ""]
      : []),
  ].join("\n");
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: md,
  });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
  logger.info(
    `${verb}: ${plans.map(([a]) => a.id).join(", ")}; ${changed.length} file(s) changed, ${backups.length} backup(s).`,
  );
  void vscode.window.showInformationMessage(
    `${verb}: ${changed.length} file(s) updated${clipboard ? "; manual-step values copied to clipboard" : ""}.`,
  );
}
