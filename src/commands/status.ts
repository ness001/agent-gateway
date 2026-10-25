import * as path from "path";
import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import type { HealthSnapshot } from "../gateway/health";
import { CONFIG_SECTION, type GatewayLogLevel } from "../utils/config";
import { logger } from "../utils/logger";
import { changeLogLevel } from "./logLevel";
import { remoteStateText } from "./remotes";
import {
  type DevTunnelSharingState,
  devTunnelSharingState,
  devTunnelSharingText,
} from "./share";

export const RECENT_ERRORS_SHOWN = 5;

export type StatusAction =
  | "restart"
  | "changePort"
  | "fallbackModel"
  | "models"
  | "copyHealth"
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

function apiUrlItems(h: HealthSnapshot): StatusItem[] {
  if (!h.listener.active || !h.listener.address) {
    return [];
  }
  const base = h.listener.address.replace(/\/+$/, "");
  const geminiDetail =
    "Select to copy. Replace {model} with a model ID from GET /v1/models.";
  return [
    { label: "API URLs — select to copy", separator: true },
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

const ACTIONS: [StatusAction, string, string?][] = [
  ["restart", "$(debug-restart) Restart gateway"],
  ["changePort", "$(plug) Change port"],
  ["fallbackModel", "$(arrow-swap) Set fallback model"],
  ["copyHealth", "$(copy) Copy health details"],
  ["openErrorLog", "$(file) Open error log", "Failed requests, last 7 days"],
  ["showLog", "$(output) Show output log"],
  ["logLevel", "$(settings-gear) Change log level"],
  ["setApiKey", "$(key) Set gateway API key"],
  ["remotes", "$(remote) Manage remote upstreams"],
  ["share", "$(radio-tower) Start sharing via dev tunnel"],
  ["webSearch", "$(search) Web search and fetch"],
  ["clients", "$(gear) Configure coding agents"],
];

/** Items of the Status picker: state, recent errors, API URLs, then actions. */
export function statusItems(
  h: HealthSnapshot,
  logLevel: GatewayLogLevel = "info",
  sharing: DevTunnelSharingState = devTunnelSharingState(),
): StatusItem[] {
  const recent = h.errors.recent.slice(0, RECENT_ERRORS_SHOWN);
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
    ...apiUrlItems(h),
    { label: "Actions", separator: true },
    ...ACTIONS.map(([action, label, description]) => ({
      label:
        action === "share" && sharing.status !== "inactive"
          ? "$(radio-tower) Manage sharing via dev tunnel"
          : label,
      description:
        action === "logLevel"
          ? `Current: ${logLevel}`
          : action === "share" && sharing.status !== "inactive"
            ? devTunnelSharingText(sharing)
            : description,
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

async function showModels(gw: Gateway): Promise<void> {
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

export async function showStatus(
  gw: Gateway,
  run: Record<
    Exclude<StatusAction, "showLog" | "logLevel" | "models">,
    () => Thenable<unknown>
  >,
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
  if (picked?.url) {
    await vscode.env.clipboard.writeText(picked.url);
    void vscode.window.showInformationMessage("Gateway API URL copied.");
    return;
  }
  if (!picked?.action) {
    return;
  }
  if (picked.action === "models") {
    await showModels(gw);
    return;
  }
  if (picked.action === "showLog") {
    logger.show();
    return;
  }
  if (picked.action === "logLevel") {
    await changeLogLevel();
    return;
  }
  await run[picked.action]();
}
