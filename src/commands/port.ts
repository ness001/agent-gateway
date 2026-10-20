import * as vscode from "vscode";

import { IS_DEV_VARIANT } from "../gateway/devVariant";
import type { Gateway } from "../gateway/gateway";
import { CONFIG_SECTION } from "../utils/config";
import { DEV_PORT } from "../utils/constant";

/** Error text for an invalid port entry, or undefined when valid. */
export function validatePort(
  value: string,
  current: number,
): string | undefined {
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    return "Enter a whole number between 1024 and 65535.";
  }
  const port = Number(text);
  if (port < 1024 || port > 65535) {
    return "Use a port between 1024 and 65535.";
  }
  if (port === current) {
    return "That is the current port.";
  }
  if (port === DEV_PORT) {
    return `Port ${DEV_PORT} is reserved for the development build.`;
  }
  return undefined;
}

/**
 * Asks for a new listener port, saves `agentGateway.port` (the gateway
 * restarts on the setting change), then offers to update coding agent
 * configurations, which still point at the old URL.
 */
export async function changePort(
  gw: Pick<Gateway, "port" | "onDidChangeStatus">,
  reconfigureClients: () => Thenable<unknown>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<number>("port", 24444);
  if (IS_DEV_VARIANT) {
    void vscode.window.showInformationMessage(
      `The development build always listens on port ${DEV_PORT}. The port setting applies to the installed release.`,
    );
  }
  const value = await vscode.window.showInputBox({
    title: "Agent Gateway port",
    prompt: `Loopback port for the gateway (currently ${current}).`,
    value: String(current),
    validateInput: (v) => validatePort(v, current),
  });
  if (value === undefined) {
    return;
  }
  const port = Number(value.trim());
  await config.update("port", port, vscode.ConfigurationTarget.Global);
  const pick = await vscode.window.showInformationMessage(
    `Gateway port changed to ${port}. Coding agents configured for port ${current} must be updated to keep working.`,
    "Configure Coding Agents",
  );
  if (!pick) {
    return;
  }
  if (!IS_DEV_VARIANT && !(await listeningOn(gw, port))) {
    void vscode.window.showErrorMessage(
      `The gateway is not listening on port ${port} yet. Check Agent Gateway: Status, then run Configure Coding Agents.`,
    );
    return;
  }
  await reconfigureClients();
}

/** Resolves true once the gateway listens on `port`, false after `timeoutMs`. */
export function listeningOn(
  gw: Pick<Gateway, "port" | "onDidChangeStatus">,
  port: number,
  timeoutMs = 15000,
): Promise<boolean> {
  if (gw.port === port) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, timeoutMs);
    const sub = gw.onDidChangeStatus(() => {
      if (gw.port === port) {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      }
    });
  });
}
