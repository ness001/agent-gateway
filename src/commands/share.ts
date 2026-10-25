import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";

import {
  DEV_TUNNEL_DOCS_URL,
  DevTunnelCli,
  DevTunnelError,
  DevTunnelHost,
  clientSetupText,
  findDevTunnelCli,
} from "../gateway/devTunnel";
import { validateModelInfo } from "../gateway/discovery";
import type { Gateway } from "../gateway/gateway";
import { type DiscoverRemoteOptions, discoverRemote } from "../gateway/remote";
import { LLM_API_KEY_SECRET_KEY } from "../utils/constant";
import { logger } from "../utils/logger";

const TUNNEL_URL_STATE_KEY = "agentGateway.devTunnelUrl";

async function storeGatewayKey(
  context: vscode.ExtensionContext,
  key: string,
  logMessage: string,
): Promise<void> {
  await context.secrets.store(LLM_API_KEY_SECRET_KEY, key);
  logger.info(logMessage);
  const copy = await vscode.window.showInformationMessage(
    "Gateway API key set. It is shown only once: copy it and give it to the client. Local clients on this machine must now also send it.",
    { modal: true, detail: key },
    "Copy key",
  );
  if (copy === "Copy key") {
    await vscode.env.clipboard.writeText(key);
  }
}

/** Set or rotate the gateway API key: enter your own or generate one. */
export async function setGatewayApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const how = await vscode.window.showQuickPick(
    [
      { label: "$(sparkle) Generate a random key", id: "generate" },
      { label: "$(edit) Enter my own key", id: "enter" },
    ],
    { title: "Set / rotate gateway API key" },
  );
  if (!how) {
    return;
  }
  let key: string;
  if (how.id === "generate") {
    key = randomBytes(32).toString("base64url");
  } else {
    const value = await vscode.window.showInputBox({
      prompt: "Gateway API key required from clients.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a key."),
    });
    if (!value?.trim()) {
      return;
    }
    key = value.trim();
  }
  await storeGatewayKey(context, key, "Gateway API key set.");
}

export async function removeGatewayApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!(await context.secrets.get(LLM_API_KEY_SECRET_KEY))) {
    void vscode.window.showInformationMessage("No gateway API key is stored.");
    return;
  }
  if (isSharing()) {
    const ok = await vscode.window.showWarningMessage(
      "The gateway is shared through a dev tunnel that allows anonymous access. Without an API key anyone with the URL can use this machine's Copilot quota. Remove the key?",
      { modal: true },
      "Remove key",
    );
    if (ok !== "Remove key") {
      return;
    }
  }
  await context.secrets.delete(LLM_API_KEY_SECRET_KEY);
  logger.info("Gateway API key removed.");
  void vscode.window.showInformationMessage("Gateway API key removed.");
}

/**
 * Hidden "Set Gateway API Key" input: an empty value removes the stored key.
 */
export async function hiddenSetApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt:
      "Gateway API key required from clients. Leave empty to remove the stored value.",
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  if (value.trim() === "") {
    await removeGatewayApiKey(context);
  } else {
    await context.secrets.store(LLM_API_KEY_SECRET_KEY, value.trim());
    void vscode.window.showInformationMessage("Key stored.");
  }
}

export interface DevTunnelSharingState {
  status: "inactive" | "starting" | "connecting" | "connected" | "checkFailed";
  url?: string;
  modelCount?: number;
  reason?: string;
}

/** A check belongs to one owned host session, never a saved tunnel URL. */
export class DevTunnelConnection {
  private session = 0;
  private current: DevTunnelSharingState = { status: "inactive" };

  get state(): DevTunnelSharingState {
    return this.current;
  }

  reset(): void {
    this.session++;
    this.current = { status: "inactive" };
  }

  async check(
    url: string,
    apiKey: string | undefined,
    options: Partial<DiscoverRemoteOptions> = {},
  ): Promise<boolean> {
    const session = ++this.session;
    this.current = { status: "connecting", url };
    const { state } = await discoverRemote(
      { name: "shared-gateway", url },
      {
        apiKey,
        attempts: 3,
        attemptTimeoutMs: 5000,
        retryDelayMs: 1000,
        ...options,
        validate: validateModelInfo,
      },
    );
    if (session !== this.session) {
      return false;
    }
    this.current =
      state.status === "ready"
        ? { status: "connected", url, modelCount: state.modelCount }
        : { status: "checkFailed", url, reason: state.reason };
    return true;
  }
}

export function devTunnelSharingText(state: DevTunnelSharingState): string {
  switch (state.status) {
    case "inactive":
      return "Inactive";
    case "starting":
      return "Starting…";
    case "connecting":
      return "Connecting…";
    case "connected":
      return `Connected (${state.modelCount} models)`;
    case "checkFailed":
      return "Connection check failed";
  }
}

const connection = new DevTunnelConnection();
let tunnelHost: DevTunnelHost | undefined;
let startingShare: Promise<void> | undefined;

function hostFor(context: vscode.ExtensionContext): DevTunnelHost {
  if (!tunnelHost) {
    tunnelHost = new DevTunnelHost(undefined, (exit) => {
      connection.reset();
      startingShare = undefined;
      logger.warn(
        `Background dev tunnel host stopped (kind: ${exit.kind}, code: ${exit.code ?? "none"}, signal: ${exit.signal ?? "none"}).`,
      );
      void vscode.window.showWarningMessage(
        "The background dev tunnel host stopped. Run 'Share Gateway via Dev Tunnel' to start it again.",
      );
    });
    context.subscriptions.push(tunnelHost);
  }
  return tunnelHost;
}

export function devTunnelSharingState(): DevTunnelSharingState {
  if (tunnelHost?.active) {
    return connection.state;
  }
  return { status: startingShare ? "starting" : "inactive" };
}

function isSharing(): boolean {
  return Boolean(tunnelHost?.active);
}

export async function stopDevTunnelHosting(): Promise<void> {
  connection.reset();
  startingShare = undefined;
  tunnelHost?.dispose();
  await tunnelHost?.stop();
}

export type ShareAction =
  | "copyUrl"
  | "copySetup"
  | "stop"
  | "setKey"
  | "removeKey";

/** Actions offered while a tunnel is hosted. */
export function shareActionItems(
  url: string | undefined,
  hasKey: boolean,
): { label: string; id: ShareAction; description?: string }[] {
  return [
    ...(url
      ? [
          {
            label: "$(copy) Copy URL",
            id: "copyUrl" as const,
            description: url,
          },
          { label: "$(clippy) Copy client setup", id: "copySetup" as const },
        ]
      : []),
    { label: "$(debug-stop) Stop sharing", id: "stop" },
    {
      label: "$(key) Set / rotate gateway API key",
      id: "setKey",
      description: hasKey ? "a key is set" : "no key: anonymous access",
    },
    ...(hasKey
      ? [{ label: "$(trash) Remove gateway API key", id: "removeKey" as const }]
      : []),
  ];
}

export async function shareViaDevTunnel(
  context: vscode.ExtensionContext,
  gw: Gateway,
): Promise<void> {
  if (startingShare && !isSharing()) {
    return startingShare;
  }
  const host = hostFor(context);
  if (!host.active) {
    const starting = startSharing(context, gw, host).finally(() => {
      if (startingShare === starting) {
        startingShare = undefined;
      }
    });
    startingShare = starting;
    return starting;
  }
  const url = connection.state.url;
  const hasKey = Boolean(await context.secrets.get(LLM_API_KEY_SECRET_KEY));
  const picked = await vscode.window.showQuickPick(
    shareActionItems(url, hasKey),
    {
      title: `Dev tunnel: ${devTunnelSharingText(connection.state)}${url ? `: ${url}` : ""}`,
    },
  );
  switch (picked?.id) {
    case "copyUrl":
      await vscode.env.clipboard.writeText(url ?? "");
      return;
    case "copySetup":
      await vscode.env.clipboard.writeText(
        clientSetupText(os.hostname(), url ?? ""),
      );
      return;
    case "stop":
      connection.reset();
      startingShare = undefined;
      try {
        await host.stop();
        logger.info("Stopped sharing the gateway via dev tunnel.");
        void vscode.window.showInformationMessage(
          "Stopped sharing. The tunnel is kept and reused next time.",
        );
      } catch {
        logger.warn("The background dev tunnel host could not be stopped.");
        void vscode.window.showErrorMessage(
          "The background dev tunnel host could not be stopped. Reload VS Code and check the devtunnel process before removing the gateway API key.",
        );
      }
      return;
    case "setKey":
      return setGatewayApiKey(context);
    case "removeKey":
      return removeGatewayApiKey(context);
  }
}

const TUNNEL_ID_STATE_KEY = "agentGateway.devTunnelId";

function errorText(error: unknown): string {
  if (error instanceof DevTunnelError) {
    return error.message;
  }
  return "Unexpected error; see the Agent Gateway log.";
}

function runInTerminal(name: string, command: string): void {
  vscode.window.terminals.find((t) => t.name === name)?.dispose();
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  terminal.sendText(command);
}

function shellCommand(cliPath: string): string {
  return cliPath.includes(" ") ? `& "${cliPath}"` : cliPath;
}

async function startSharing(
  context: vscode.ExtensionContext,
  gw: Gateway,
  host: DevTunnelHost,
): Promise<void> {
  const port = gw.port;
  if (port === undefined) {
    void vscode.window.showErrorMessage(
      `The gateway is not listening (status: ${gw.state}). Start it before sharing.`,
    );
    return;
  }
  const cliPath = await findDevTunnelCli();
  if (!cliPath) {
    logger.warn("Share via dev tunnel: devtunnel CLI not found.");
    const pick = await vscode.window.showErrorMessage(
      "The devtunnel CLI is not installed (not on PATH or in the WinGet links folder).",
      "Install (winget)",
      "Open docs",
    );
    if (pick === "Install (winget)") {
      runInTerminal("Install devtunnel", "winget install Microsoft.devtunnel");
      void vscode.window.showInformationMessage(
        "After installation finishes, rerun 'Share Gateway via Dev Tunnel'.",
      );
    } else if (pick === "Open docs") {
      void vscode.env.openExternal(vscode.Uri.parse(DEV_TUNNEL_DOCS_URL));
    }
    return;
  }
  if (cliPath !== "devtunnel") {
    logger.info(
      `devtunnel is not on PATH; falling back to ${cliPath} (WinGet links folder).`,
    );
    void vscode.window.showInformationMessage(
      `devtunnel is not on PATH; using fallback ${cliPath}.`,
    );
  }
  const cli = new DevTunnelCli(cliPath, undefined, logger);
  try {
    if (!(await cli.isLoggedIn())) {
      logger.warn("Share via dev tunnel: devtunnel is not signed in.");
      runInTerminal("devtunnel login", `${shellCommand(cliPath)} user login`);
      void vscode.window.showWarningMessage(
        "devtunnel is not signed in (anonymous users cannot create tunnels). Finish 'devtunnel user login' in the terminal, then rerun 'Share Gateway via Dev Tunnel'.",
      );
      return;
    }

    if (!(await context.secrets.get(LLM_API_KEY_SECRET_KEY))) {
      const choice = await vscode.window.showWarningMessage(
        "The tunnel URL allows anonymous access: anyone with it can use this machine's Copilot quota. Protect the gateway with an API key?",
        { modal: true },
        "Generate API key",
        "Continue without key",
      );
      if (!choice) {
        return;
      }
      if (choice === "Generate API key") {
        await storeGatewayKey(
          context,
          randomBytes(32).toString("base64url"),
          "Generated a gateway API key for dev tunnel sharing.",
        );
      } else {
        logger.warn("Sharing gateway via dev tunnel without an API key.");
      }
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing dev tunnel...",
      },
      () =>
        cli.ensureTunnel(
          context.globalState.get<string>(TUNNEL_ID_STATE_KEY),
          port,
        ),
    );
    await context.globalState.update(TUNNEL_ID_STATE_KEY, result.tunnelId);
    await context.globalState.update(TUNNEL_URL_STATE_KEY, result.url);
    const apiKey = await context.secrets.get(LLM_API_KEY_SECRET_KEY);
    await host.start(cliPath, result.tunnelId);
    if (!host.active) {
      return;
    }
    logger.info(
      `Started background dev tunnel host (${result.created ? "new" : "reused"}) for port ${port} (URL source: ${result.urlSource}).`,
    );
    const checked = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          "Dev tunnel: Connecting… Run Share Gateway via Dev Tunnel to stop sharing.",
      },
      () => connection.check(result.url, apiKey),
    );
    if (!checked || !host.active) {
      return;
    }
    if (connection.state.status === "checkFailed") {
      logger.warn(
        `Dev tunnel connection check failed: ${connection.state.reason}`,
      );
      void vscode.window.showWarningMessage(
        `Dev tunnel connection check failed: ${connection.state.reason} The background host is still running. Run 'Share Gateway via Dev Tunnel' to stop sharing.`,
      );
      return;
    }
    logger.info(
      `Dev tunnel public catalog check succeeded (${connection.state.modelCount} models).`,
    );
    void vscode.window
      .showInformationMessage(
        `Dev tunnel: Connected (${connection.state.modelCount} models). Tunnel URL: ${result.url}. Run this command again to stop sharing.`,
        "Copy URL",
        "Copy client setup",
      )
      .then((pick) => {
        if (pick === "Copy URL") {
          return vscode.env.clipboard.writeText(result.url);
        } else if (pick === "Copy client setup") {
          return vscode.env.clipboard.writeText(
            clientSetupText(os.hostname(), result.url),
          );
        }
        return undefined;
      });
  } catch (error) {
    logger.error(`Share via dev tunnel failed: ${errorText(error)}`);
    void vscode.window
      .showErrorMessage(errorText(error), "Show log")
      .then((p) => p && logger.show());
  }
}
