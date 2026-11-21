import * as vscode from "vscode";

import { devTunnelSharingState, devTunnelSharingText } from "../commands/share";
import { STATUS_COMMANDS, type StatusAction } from "../commands/status";
import type { Gateway } from "../gateway/gateway";
import type { GatewayStatus, HealthSnapshot } from "../gateway/health";
import { readConfiguration } from "../utils/config";
import { type SidebarSection, statusHtml } from "./statusHtml";

export const STATUS_VIEW_ID = "agentGateway.status";

const ICONS: Record<GatewayStatus, string> = {
  "Running in another window": "window",
  Starting: "sync~spin",
  Ready: "pass",
  "Waiting for Copilot": "watch",
  "Port conflict": "warning",
  Error: "error",
  Disabled: "circle-slash",
};

export class GatewayStatusProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly snapshot: () => HealthSnapshot,
    private readonly modelCount: () => number,
    private readonly section = "status",
  ) {}

  refresh(): void {
    this.changes.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      return [];
    }
    const h = this.snapshot();
    const config = readConfiguration();
    const sharing = devTunnelSharingState();
    const row = (
      id: string,
      label: string,
      value: string,
      icon: string,
      action?: StatusAction,
    ) => {
      const item = new vscode.TreeItem(label);
      item.id = id;
      item.description = value;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${label}: ${value}`;
      item.accessibilityInformation = { label: `${label}: ${value}` };
      if (action) {
        item.command = { command: STATUS_COMMANDS[action], title: label };
        item.tooltip += "\nSelect to open the corresponding gateway command.";
      }
      return item;
    };
    const rows = [
      row("state", "Gateway", h.status, ICONS[h.status]),
      ...(h.sharedStatus
        ? [
            row(
              "owner",
              "Active gateway",
              h.sharedStatus,
              ICONS[h.sharedStatus],
            ),
          ]
        : []),
      row(
        "listener",
        "Listener",
        h.listener.address ?? "Inactive",
        "plug",
        "changePort",
      ),
      row(
        "apiUrls",
        "API URLs",
        h.listener.active ? "Select to copy" : "Inactive",
        "link",
        "apiUrls",
      ),
      row(
        "models",
        "Available models",
        String(h.sharedStatus ? h.modelCount : this.modelCount()),
        "symbol-misc",
        "models",
      ),
      row(
        "remotes",
        "Remote gateways",
        `${h.remotes.filter((r) => r.status === "ready").length} ready / ${h.remotes.length} configured`,
        "remote",
        "remotes",
      ),
      row(
        "fallback",
        "Fallback model",
        h.fallbackModel ?? "None",
        "arrow-swap",
        "fallbackModel",
      ),
      row(
        "sharing",
        "Dev tunnel sharing",
        devTunnelSharingText(sharing),
        "radio-tower",
        "share",
      ),
      row(
        "search",
        "Web search engine",
        config.webSearch.provider,
        "search",
        "webSearch",
      ),
      row(
        "logLevel",
        "Log level",
        config.logLevel,
        "settings-gear",
        "logLevel",
      ),
      row("apiKey", "Set gateway API key", "", "key", "setApiKey"),
      row("clients", "Configure coding agents", "", "gear", "clients"),
      ...(h.lastStartupError
        ? [row("error", "Startup error", h.lastStartupError, "error")]
        : []),
      row("output", "Open output log", "", "output", "showLog"),
      row("errors", "Open error log", "", "file", "openErrorLog"),
      row("restart", "Restart gateway", "", "debug-restart", "restart"),
      row(
        "copilot",
        "Copilot Chat",
        h.copilot.installed
          ? h.copilot.active
            ? "Active"
            : "Installed, inactive"
          : "Not installed",
        "copilot",
      ),
      row("version", "Extension version", h.bridgeVersion, "versions"),
    ];
    const byId = new Map(rows.map((item) => [item.id, item]));
    const groupRows: Record<string, string[]> = {
      agentSetup: ["clients", "fallback", "search"],
      connections: ["remotes", "sharing", "apiKey", "apiUrls", "changePort"],
      diagnostics: ["output", "errors", "logLevel"],
    };
    byId.set(
      "changePort",
      row("changePort", "Change port", "", "plug", "changePort"),
    );
    // Listener and model count are information, not configuration controls.
    byId.get("listener")!.command = undefined;
    if (this.section !== "status") {
      return (groupRows[this.section] ?? []).map((id) => byId.get(id)!);
    }
    const top = [
      "state",
      "owner",
      "version",
      "copilot",
      "listener",
      "models",
      "error",
      "restart",
    ]
      .map((id) => byId.get(id))
      .filter((item): item is vscode.TreeItem => !!item);
    return top;
  }

  dispose(): void {
    this.changes.dispose();
  }
}

export function registerStatusView(
  context: vscode.ExtensionContext,
  gw: Gateway,
): void {
  let currentView: vscode.WebviewView | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sections = [
    ["status", "Status"],
    ["agentSetup", "Agent Setup"],
    ["connections", "Connections"],
    ["diagnostics", "Diagnostics"],
  ];
  const providers = sections.map(
    ([id]) =>
      new GatewayStatusProvider(
        () => gw.health(),
        () => gw.nativeModels().length,
        id,
      ),
  );
  const refresh = () => {
    if (!currentView?.visible) {
      return;
    }
    const data: SidebarSection[] = sections.map(([id, label], index) => ({
      id,
      label,
      rows: providers[index].getChildren().map((row) => ({
        id: row.id!,
        label: String(row.label),
        value: String(row.description ?? ""),
        action: row.command?.command,
      })),
    }));
    void currentView.webview.postMessage({ type: "sections", sections: data });
  };
  const visibility = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (currentView?.visible) {
      refresh();
      timer = setInterval(refresh, 2000);
    }
  };
  context.subscriptions.push(
    ...providers,
    vscode.window.registerWebviewViewProvider(STATUS_VIEW_ID, {
      resolveWebviewView(view) {
        currentView = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = statusHtml();
        context.subscriptions.push(
          view.webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== "object") {
              return;
            }
            const data = message as { type?: unknown; action?: unknown };
            if (data.type === "ready") {
              refresh();
            }
            if (
              data.type === "action" &&
              typeof data.action === "string" &&
              Object.values(STATUS_COMMANDS).includes(data.action)
            ) {
              void vscode.commands.executeCommand(data.action);
            }
          }),
          view.onDidChangeVisibility(visibility),
          view.onDidDispose(() => {
            currentView = undefined;
            visibility();
          }),
        );
        visibility();
      },
    }),
    gw.onDidChangeStatus(refresh),
    {
      dispose: () => {
        if (timer) {
          clearInterval(timer);
        }
      },
    },
    vscode.commands.registerCommand("agentGateway.openSidebar", () =>
      vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand("agentGateway.refreshStatus", refresh),
  );
}
