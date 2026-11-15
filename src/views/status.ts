import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { GatewayStatus, HealthSnapshot } from "../gateway/health";

export const STATUS_VIEW_ID = "agentGateway.status";

const ICONS: Record<GatewayStatus, string> = {
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
    const row = (
      id: string,
      label: string,
      value: string,
      icon: string,
      command?: string,
    ) => {
      const item = new vscode.TreeItem(label);
      item.id = id;
      item.description = value;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${label}: ${value}`;
      item.accessibilityInformation = { label: `${label}: ${value}` };
      if (command) {
        item.command = { command, title: label };
      }
      return item;
    };
    return [
      row("state", "Gateway", h.status, ICONS[h.status]),
      row("listener", "Listener", h.listener.address ?? "Inactive", "plug"),
      row(
        "models",
        "Available models",
        String(this.modelCount()),
        "symbol-misc",
      ),
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
      row(
        "remotes",
        "Remote gateways",
        `${h.remotes.filter((r) => r.status === "ready").length} ready / ${h.remotes.length} configured`,
        "remote",
      ),
      row(
        "fallback",
        "Fallback model",
        h.fallbackModel ?? "None",
        "arrow-swap",
      ),
      row("version", "Extension version", h.bridgeVersion, "versions"),
      ...(h.lastStartupError
        ? [row("error", "Startup error", h.lastStartupError, "error")]
        : []),
      row("output", "Open output log", "", "output", "agentGateway.showOutput"),
      row("errors", "Open error log", "", "file", "agentGateway.openErrorLog"),
      row(
        "health",
        "Copy health details",
        "",
        "copy",
        "agentGateway.copyHealth",
      ),
      row(
        "restart",
        "Restart gateway",
        "",
        "debug-restart",
        "agentGateway.restart",
      ),
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
