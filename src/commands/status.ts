import * as path from "path";
import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { HealthSnapshot } from "../gateway/health";
import { logger } from "../utils/logger";
import { remoteStateText } from "./remotes";

export const RECENT_ERRORS_SHOWN = 5;

export type StatusAction =
  | "restart"
  | "changePort"
  | "fallbackModel"
  | "copyHealth"
  | "openErrorLog"
  | "showLog"
  | "setApiKey"
  | "remotes"
  | "webSearch"
  | "clients";

export interface StatusItem {
  label: string;
  description?: string;
  detail?: string;
  separator?: boolean;
  action?: StatusAction;
}

const ACTIONS: [StatusAction, string, string?][] = [
  ["restart", "$(debug-restart) Restart gateway"],
  ["changePort", "$(plug) Change port"],
  ["fallbackModel", "$(arrow-swap) Set fallback model"],
  ["copyHealth", "$(copy) Copy health details"],
  ["openErrorLog", "$(file) Open error log", "Failed requests, last 7 days"],
  ["showLog", "$(output) Show output log"],
  ["setApiKey", "$(key) Set gateway API key"],
  ["remotes", "$(remote) Manage remote upstreams"],
  ["webSearch", "$(search) Web search and fetch"],
  ["clients", "$(gear) Configure coding agents"],
];

/** Items of the Status picker: state lines, recent errors, then actions. */
export function statusItems(h: HealthSnapshot): StatusItem[] {
  const recent = h.errors.recent.slice(0, RECENT_ERRORS_SHOWN);
  return [
    { label: `Status: ${h.status}` },
    { label: `Listener: ${h.listener.address ?? "inactive"}` },
    { label: `Models: ${h.modelCount}` },
    h.fallbackModel
      ? {
          label: `Fallback model: ${h.fallbackModel}`,
          description: h.fallbackModelSource ?? undefined,
        }
      : { label: "Fallback model: none — set agentGateway.fallbackModel" },
    {
      label: `Copilot Chat: ${h.copilot.installed ? (h.copilot.active ? "active" : "installed, inactive") : "not installed"}`,
    },
    ...h.remotes.map((r) => ({
      label: `Remote ${r.name}: ${remoteStateText(r)}`,
    })),
    ...(h.lastStartupError
      ? [{ label: `Last startup error: ${h.lastStartupError}` }]
      : []),
    ...(recent.length > 0
      ? [
          { label: "Recent errors", separator: true },
          ...recent.map((e) => ({
            label: `${e.status} ${e.kind ?? ""} ${e.model ?? ""}`
              .replace(/\s+/g, " ")
              .trim(),
            description: `request ${e.requestId}`,
            detail: `${e.time} ${e.protocol} ${e.method} ${e.path}${e.remote ? ` via ${e.remote}` : ""} ${e.elapsedMs}ms`,
          })),
        ]
      : []),
    { label: "Actions", separator: true },
    ...ACTIONS.map(([action, label, description]) => ({
      label,
      description,
      action,
    })),
  ];
}

export async function openErrorLog(gw: Gateway): Promise<void> {
  const dir = gw.errorJournal.logDirectory;
  if (!dir) {
    void vscode.window.showWarningMessage(
      "The error log is unavailable in this VS Code session.",
    );
    return;
  }
  await gw.errorJournal.flush();
  const day = new Date().toISOString().slice(0, 10);
  const today = vscode.Uri.file(path.join(dir, `errors-${day}.jsonl`));
  try {
    await vscode.workspace.fs.stat(today);
    await vscode.window.showTextDocument(today, { preview: true });
  } catch {
    // No failures today: open the folder that holds earlier days.
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(dir),
    );
  }
}

export async function copyHealth(gw: Gateway): Promise<void> {
  await vscode.env.clipboard.writeText(JSON.stringify(gw.health(), null, 2));
  void vscode.window.showInformationMessage("Gateway health copied.");
}

export async function showStatus(
  gw: Gateway,
  run: Record<Exclude<StatusAction, "showLog">, () => Thenable<unknown>>,
): Promise<void> {
  const items = statusItems(gw.health()).map((i) => ({
    ...i,
    kind: i.separator ? vscode.QuickPickItemKind.Separator : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Agent Gateway",
  });
  if (!picked?.action) {
    return;
  }
  if (picked.action === "showLog") {
    logger.show();
    return;
  }
  await run[picked.action]();
}
