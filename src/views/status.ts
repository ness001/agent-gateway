import * as vscode from "vscode";

import { devTunnelSharingState, devTunnelSharingText } from "../commands/share";
import { STATUS_COMMANDS, type StatusAction } from "../commands/status";
import type { Gateway } from "../gateway/gateway";
import type { GatewayStatus, HealthSnapshot } from "../gateway/health";
import { readConfiguration } from "../utils/config";

export const STATUS_VIEW_ID = "agentGateway.status";

const ICONS: Record<GatewayStatus, string> = {
  "Running in another window": "windows",
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
  ) {}

  refresh(): void {
    this.changes.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
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
    return [
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
      row("health", "Copy health details", "", "copy", "copyHealth"),
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
  }

  dispose(): void {
    this.changes.dispose();
  }
}

export function registerStatusView(
  context: vscode.ExtensionContext,
  gw: Gateway,
): void {
  const provider = new GatewayStatusProvider(
    () => gw.health(),
    () => gw.nativeModels().length,
  );
  const view = vscode.window.createTreeView(STATUS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  // Refresh only while visible, including model discovery and health changes
  // that do not change the gateway's overall readiness state.
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
    vscode.commands.registerCommand("agentGateway.openSidebar", () =>
      vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand("agentGateway.refreshStatus", () =>
      provider.refresh(),
    ),
  );
  visibility();
}
