import * as path from "path";
import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { HealthSnapshot } from "../gateway/health";
import { CONFIG_SECTION, type GatewayLogLevel } from "../utils/config";
import { remoteStateText } from "./remotes";
import {
  type DevTunnelSharingState,
  devTunnelSharingState,
  devTunnelSharingText,
} from "./share";

export type StatusAction =
  | "apiUrls"
  | "restart"
  | "changePort"
  | "fallbackModel"
  | "models"
  | "openErrorLog"
  | "showLog"
  | "logLevel"
  | "setApiKey"
  | "remotes"
  | "share"
  | "webSearch"
  | "clients";

export interface StatusItem {
  label: string;
  description?: string;
  detail?: string;
  separator?: boolean;
  action?: StatusAction;
  url?: string;
}

/** Items of the API URLs sub-picker; empty when the listener is inactive. */
export function apiUrlItems(h: HealthSnapshot): StatusItem[] {
  if (!h.listener.active || !h.listener.address) {
    return [];
  }
  const base = h.listener.address.replace(/\/+$/, "");
  const geminiDetail =
    "Select to copy. Replace {model} with a model ID from GET /v1/models.";
  return [
    ...[
      ["Gateway base URL", "", "Base URL for Anthropic and Gemini clients."],
      [
        "OpenAI-compatible base URL",
        "/v1",
        "Base URL for OpenAI-compatible clients.",
      ],
      ["Models", "/v1/models", "GET — available model IDs for all APIs."],
      [
        "Chat Completions",
        "/v1/chat/completions",
        "POST — OpenAI-compatible chat.",
      ],
      ["Responses", "/v1/responses", "POST — OpenAI-compatible responses."],
      [
        "Anthropic messages",
        "/v1/messages",
        "POST — Anthropic-compatible messages.",
      ],
      [
        "Anthropic count tokens",
        "/v1/messages/count_tokens",
        "POST — returns input_tokens; no OpenAI token-count endpoint.",
      ],
      [
        "Gemini generate content",
        "/v1beta/models/{model}:generateContent",
        geminiDetail,
      ],
      [
        "Gemini stream content",
        "/v1beta/models/{model}:streamGenerateContent?alt=sse",
        geminiDetail,
      ],
      [
        "Gemini count tokens",
        "/v1beta/models/{model}:countTokens",
        `${geminiDetail} POST — returns totalTokens.`,
      ],
    ].map(([label, suffix, detail]) => ({
      label: `$(copy) ${label}`,
      description: `${base}${suffix}`,
      detail,
      url: `${base}${suffix}`,
    })),
  ];
}

export const STATUS_COMMANDS: Record<StatusAction, string> = {
  apiUrls: "agentGateway.showApiUrls",
  restart: "agentGateway.restart",
  changePort: "agentGateway.changePort",
  fallbackModel: "agentGateway.setFallbackModel",
  models: "agentGateway.showModels",
  openErrorLog: "agentGateway.openErrorLog",
  showLog: "agentGateway.showOutput",
  logLevel: "agentGateway.setLogLevel",
  setApiKey: "agentGateway.setGatewayApiKey",
  remotes: "agentGateway.manageRemoteUpstreams",
  share: "agentGateway.shareViaDevTunnel",
  webSearch: "agentGateway.setWebSearchEngine",
  clients: "agentGateway.configureClients",
};

export const STATUS_GROUPS = [
  {
    id: "agentSetup",
    label: "Agent Setup",
    actions: ["clients", "fallbackModel", "webSearch"],
  },
  {
    id: "connections",
    label: "Connections",
    actions: ["remotes", "share", "setApiKey", "apiUrls", "changePort"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    actions: ["showLog", "openErrorLog", "logLevel"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  actions: readonly StatusAction[];
}[];

export async function showStatusGroup(
  id: (typeof STATUS_GROUPS)[number]["id"],
): Promise<void> {
  const group = STATUS_GROUPS.find((g) => g.id === id)!;
  const picked = await vscode.window.showQuickPick(
    group.actions.map((action) => ({
      label:
        action === "apiUrls"
          ? "$(link) API URLs"
          : ACTIONS.find(([key]) => key === action)![1],
      action,
    })),
    { title: `Agent Gateway: ${group.label}` },
  );
  if (picked) {
    await vscode.commands.executeCommand(STATUS_COMMANDS[picked.action]);
  }
}

const ACTIONS: [StatusAction, string, string?][] = [
  ["restart", "$(debug-restart) Restart gateway"],
  ["changePort", "$(plug) Change port"],
  ["fallbackModel", "$(arrow-swap) Set fallback model"],
  ["openErrorLog", "$(file) Open error log", "Failed requests, last 7 days"],
  ["showLog", "$(output) Open output log"],
  ["logLevel", "$(settings-gear) Set log level"],
  ["setApiKey", "$(key) Set gateway API key"],
  ["remotes", "$(remote) Manage remote gateways"],
  ["share", "$(radio-tower) Share gateway via dev tunnel"],
  ["webSearch", "$(search) Set web search engine"],
  ["clients", "$(gear) Configure coding agents"],
];

/** Items of the Status picker: state, then actions (API URLs in a sub-picker). */
export function statusItems(
  h: HealthSnapshot,
  logLevel: GatewayLogLevel = "info",
  sharing: DevTunnelSharingState = devTunnelSharingState(),
): StatusItem[] {
  return [
    { label: `Status: ${h.status}` },
    { label: `Listener: ${h.listener.address ?? "inactive"}` },
    {
      label: `Dev tunnel sharing: ${devTunnelSharingText(sharing)}`,
      description: sharing.url,
      detail:
        sharing.status === "connected"
          ? "Last connection check succeeded."
          : sharing.status === "checkFailed"
            ? sharing.reason
            : undefined,
    },
    {
      label: `Models: ${h.modelCount}`,
      detail:
        "Browse discovered local and remote models; select to copy a model ID.",
      action: "models",
    },
    h.fallbackModel
      ? {
          label: `Fallback model: ${h.fallbackModel}`,
          description: h.fallbackModelSource ?? undefined,
        }
      : { label: "Fallback model: none" },
    ...h.remotes.map((r) => ({
      label: `Remote ${r.name}: ${remoteStateText(r)}`,
    })),
    ...(h.lastStartupError
      ? [{ label: `Last startup error: ${h.lastStartupError}` }]
      : []),
    { label: "Actions", separator: true },
    ...(apiUrlItems(h).length > 0
      ? [
          {
            label: "$(link) API URLs",
            detail: "Gateway endpoints for clients; select to copy a URL.",
            action: "apiUrls" as const,
          },
        ]
      : []),
    ...ACTIONS.map(([action, label, description]) => ({
      label:
        action === "share" && sharing.status !== "inactive"
          ? "$(radio-tower) Manage dev tunnel sharing"
          : label,
      description:
        action === "logLevel"
          ? `Current: ${logLevel}`
          : action === "share" && sharing.status !== "inactive"
            ? devTunnelSharingText(sharing)
            : description,
      action,
    })),
    {
      label: `Copilot Chat: ${h.copilot.installed ? (h.copilot.active ? "active" : "installed, inactive") : "not installed"}`,
    },
    { label: `Extension version: ${h.bridgeVersion}` },
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
  const directory = vscode.Uri.file(dir);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch (error) {
    if (
      !(error instanceof vscode.FileSystemError) ||
      error.code !== "FileNotFound"
    ) {
      throw error;
    }
    entries = [];
  }
  const names = entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File &&
        /^errors-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name),
    )
    .map(([name]) => name)
    .sort();
  const today = `errors-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const name = names.includes(today) ? today : names.at(-1);
  if (name) {
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(dir, name)),
      { preview: true },
    );
    return;
  }
  const document = await vscode.workspace.openTextDocument({
    language: "jsonl",
    content: "",
  });
  await vscode.window.showTextDocument(document, { preview: true });
  void vscode.window.showInformationMessage(
    "No gateway errors have been recorded in this window. This empty document is not a saved log file.",
  );
}

export async function showModels(gw: Gateway): Promise<void> {
  const models = gw.nativeModels();
  if (models.length === 0) {
    void vscode.window.showInformationMessage("No models discovered yet.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    models
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => ({
        label: model.id,
        description: model.remote ? `Remote: ${model.remote}` : "Local",
        detail: model.displayName,
      })),
    {
      title: `Discovered models (${models.length}) — select to copy a model ID`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (picked) {
    await vscode.env.clipboard.writeText(picked.label);
    void vscode.window.showInformationMessage(
      `Model ID copied: ${picked.label}`,
    );
  }
}

export async function showApiUrls(gw: Gateway): Promise<void> {
  const picked = await vscode.window.showQuickPick(apiUrlItems(gw.health()), {
    title: "Gateway API URLs — select to copy",
    matchOnDescription: true,
  });
  if (picked?.url) {
    await vscode.env.clipboard.writeText(picked.url);
    void vscode.window.showInformationMessage("Gateway API URL copied.");
  }
}

export async function showStatus(
  gw: Gateway,
  run?: Partial<Record<StatusAction, () => Thenable<unknown>>>,
): Promise<void> {
  const level = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<GatewayLogLevel>("logLevel", "info");
  const items = statusItems(
    { ...gw.health(), modelCount: gw.nativeModels().length },
    level,
  ).map((i) => ({
    ...i,
    kind: i.separator ? vscode.QuickPickItemKind.Separator : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Agent Gateway",
  });
  if (!picked?.action) {
    return;
  }
  const handler = run?.[picked.action];
  if (handler) {
    await handler();
  } else {
    await vscode.commands.executeCommand(STATUS_COMMANDS[picked.action]);
  }
}
