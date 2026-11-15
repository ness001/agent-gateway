import * as vscode from "vscode";

import { devTunnelSharingState, devTunnelSharingText } from "../commands/share";
import { STATUS_COMMANDS, type StatusAction } from "../commands/status";
import type { Gateway } from "../gateway/gateway";
import type { GatewayStatus, HealthSnapshot } from "../gateway/health";
import { readConfiguration } from "../utils/config";

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
  const providers: GatewayStatusProvider[] = [];
  for (const section of [
    "status",
    "agentSetup",
    "connections",
    "diagnostics",
  ]) {
    const provider = new GatewayStatusProvider(
      () => gw.health(),
      () => gw.nativeModels().length,
      section,
    );
    providers.push(provider);
    const view = vscode.window.createTreeView(`agentGateway.${section}`, {
      treeDataProvider: provider,
      showCollapseAll: false,
    });
    // Poll only visible sections; status changes also refresh immediately.
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (view.visible) {
        provider.refresh();
        timer = setInterval(() => provider.refresh(), 2000);
      }
    };
    context.subscriptions.push(
      provider,
      view,
      gw.onDidChangeStatus(() => provider.refresh()),
      view.onDidChangeVisibility(visibility),
      {
        dispose: () => {
          if (timer) {
            clearInterval(timer);
          }
        },
      },
    );
    visibility();
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("agentGateway.openSidebar", () =>
      vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand("agentGateway.refreshStatus", () =>
      providers.forEach((provider) => provider.refresh()),
    ),
  );
}
