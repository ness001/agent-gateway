import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { runClientConfiguration } from "./commands/clients";
import { setFallbackModel } from "./commands/fallback";
import { changePort } from "./commands/port";
import {
  addRemoteUpstream,
  manageRemoteUpstreams,
  removeRemoteUpstream,
  setRemoteApiKey,
} from "./commands/remotes";
import {
  hiddenSetApiKey,
  setGatewayApiKey,
  shareViaDevTunnel,
} from "./commands/share";
import { copyHealth, openErrorLog, showStatus } from "./commands/status";
import { setWebSearchEngine } from "./commands/webSearch";
import { IS_DEV_VARIANT } from "./gateway/devVariant";
import { Gateway } from "./gateway/gateway";
import type { GatewayStatus } from "./gateway/health";
import { CONFIG_SECTION } from "./utils/config";
import { logger } from "./utils/logger";

const CMD = "agentGateway";

const STATUS_ICONS: Record<GatewayStatus, string> = {
  Starting: "$(sync~spin)",
  Ready: "$(check)",
  "Waiting for Copilot": "$(watch)",
  "Port conflict": "$(warning)",
  Error: "$(error)",
  Disabled: "$(circle-slash)",
};

let gateway: Gateway | undefined;

const notifiedConflicts = new Set<string>();

async function notifyPortConflict(message: string): Promise<void> {
  const pick = await vscode.window.showWarningMessage(message, "Change port");
  if (pick === "Change port") {
    await vscode.commands.executeCommand(`${CMD}.changePort`);
  }
}

/**
 * Dev variant only: `scripts/install.ps1 -Dev` touches this file after
 * installing, and every window running the dev build restarts its extension
 * host to load the new code.
 */
export const DEV_RELOAD_FILE = path.join(
  os.tmpdir(),
  "agent-gateway-dev.reload",
);

function watchDevReload(): vscode.Disposable {
  const started = Date.now();
  const listener = (cur: fs.Stats): void => {
    if (cur.mtimeMs > started) {
      logger.info("Dev build reinstalled; restarting the extension host.");
      void vscode.commands.executeCommand(
        "workbench.action.restartExtensionHost",
      );
    }
  };
  fs.watchFile(DEV_RELOAD_FILE, { interval: 1000 }, listener);
  return { dispose: () => fs.unwatchFile(DEV_RELOAD_FILE, listener) };
}

export function activate(context: vscode.ExtensionContext): Gateway {
  const gw = new Gateway(context);
  gateway = gw;
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = `${CMD}.showStatus`;
  const render = (status: GatewayStatus) => {
    statusBar.text = `${STATUS_ICONS[status]} Gateway`;
    statusBar.tooltip = `Agent Gateway: ${status}${
      gw.address ? `\n${gw.address}` : ""
    }`;
  };
  render(gw.state);
  if (IS_DEV_VARIANT) {
    context.subscriptions.push(watchDevReload());
  }
  statusBar.show();

  context.subscriptions.push(
    gw,
    statusBar,
    logger,
    gw.onDidChangeStatus(render),
    gw.onDidEnterPortConflict((info) => {
      // One notification per occupant kind per session.
      if (notifiedConflicts.has(info.occupant)) {
        return;
      }
      notifiedConflicts.add(info.occupant);
      void notifyPortConflict(info.message);
    }),
    vscode.commands.registerCommand(`${CMD}.showStatus`, () =>
      showStatus(gw, {
        restart: () => gw.restart(),
        changePort: () => vscode.commands.executeCommand(`${CMD}.changePort`),
        fallbackModel: () => setFallbackModel(gw),
        copyHealth: () => copyHealth(gw),
        openErrorLog: () => openErrorLog(gw),
        setApiKey: () => setGatewayApiKey(context),
        remotes: () => manageRemoteUpstreams(context, gw),
        webSearch: () => setWebSearchEngine(context),
        clients: () => runClientConfiguration(context, gw),
      }),
    ),
    vscode.commands.registerCommand(`${CMD}.restart`, () => gw.restart()),
    vscode.commands.registerCommand(`${CMD}.changePort`, () =>
      changePort(gw, () => runClientConfiguration(context, gw, "configure")),
    ),
    vscode.commands.registerCommand(`${CMD}.setFallbackModel`, () =>
      setFallbackModel(gw),
    ),
    vscode.commands.registerCommand(`${CMD}.configureClients`, () =>
      runClientConfiguration(context, gw),
    ),
    vscode.commands.registerCommand(`${CMD}.setWebSearchEngine`, () =>
      setWebSearchEngine(context),
    ),
    vscode.commands.registerCommand(`${CMD}.shareViaDevTunnel`, () =>
      shareViaDevTunnel(context, gw),
    ),
    vscode.commands.registerCommand(`${CMD}.manageRemoteUpstreams`, () =>
      manageRemoteUpstreams(context, gw),
    ),
    // Former command IDs, hidden from the Command Palette but kept so
    // existing keybindings and scripts keep working.
    vscode.commands.registerCommand(`${CMD}.openErrorLog`, () =>
      openErrorLog(gw),
    ),
    vscode.commands.registerCommand(`${CMD}.copyHealth`, () => copyHealth(gw)),
    vscode.commands.registerCommand(`${CMD}.setApiKey`, () =>
      hiddenSetApiKey(context),
    ),
    vscode.commands.registerCommand(`${CMD}.setRemoteApiKey`, () =>
      setRemoteApiKey(context, gw),
    ),
    vscode.commands.registerCommand(`${CMD}.setWebSearchApiKey`, () =>
      setWebSearchEngine(context),
    ),
    vscode.commands.registerCommand(`${CMD}.unconfigureClients`, () =>
      runClientConfiguration(context, gw, "unconfigure"),
    ),
    vscode.commands.registerCommand(`${CMD}.addRemoteUpstream`, () =>
      addRemoteUpstream(context),
    ),
    vscode.commands.registerCommand(`${CMD}.removeRemoteUpstream`, () =>
      removeRemoteUpstream(context),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      const restartKeys = ["enabled", "port", "remoteUpstreams", "webSearch"];
      if (
        restartKeys.some((k) =>
          e.affectsConfiguration(`${CONFIG_SECTION}.${k}`),
        )
      ) {
        void gw.restart();
      } else {
        gw.applyLogLevel();
      }
    }),
  );

  // Never block extension host startup on discovery or binding.
  void gw.start();
  return gw;
}

export async function deactivate(): Promise<void> {
  await gateway?.stop();
  gateway = undefined;
}
