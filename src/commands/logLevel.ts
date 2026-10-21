import * as vscode from "vscode";

import { CONFIG_SECTION, type GatewayLogLevel } from "../utils/config";

const LEVELS: GatewayLogLevel[] = ["error", "warn", "info", "debug"];

export function logLevelItems(current: GatewayLogLevel) {
  return LEVELS.map((level) => ({
    label: level,
    description: level === current ? "Current" : undefined,
    picked: level === current,
  }));
}

/** Update an existing workspace override, otherwise the user preference. */
export async function changeLogLevel(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<GatewayLogLevel>("logLevel", "info");
  const picked = await vscode.window.showQuickPick(logLevelItems(current), {
    title: "Agent Gateway log level",
    placeHolder: `Current: ${current}. Changes apply without restarting the gateway.`,
  });
  if (!picked || picked.label === current) {
    return;
  }
  const inspected = config.inspect<GatewayLogLevel>("logLevel");
  const target =
    inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update("logLevel", picked.label, target);
  void vscode.window.showInformationMessage(
    `Gateway log level set to ${picked.label}.` +
      (picked.label === "debug"
        ? " Also set the Agent Gateway output channel's log level to Debug in VS Code if debug messages are hidden."
        : ""),
  );
}
