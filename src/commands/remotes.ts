import * as vscode from "vscode";

import { validateModelInfo } from "../gateway/discovery";
import type { Gateway } from "../gateway/gateway";
import { discoverRemote } from "../gateway/remote";
import {
  deriveRemoteName,
  mergeRemote,
  removeRemote,
  validateRemoteName,
  validateRemoteUrl,
} from "../gateway/remoteSetup";
import type { RemoteState } from "../gateway/types";
import { CONFIG_SECTION } from "../utils/config";
import { remoteApiKeySecretKey } from "../utils/constant";
import { logger } from "../utils/logger";

export function remoteStateText(state: RemoteState | undefined): string {
  if (!state) {
    return "not loaded yet";
  }
  return state.status === "ready"
    ? `ready, ${state.modelCount} model${state.modelCount === 1 ? "" : "s"}`
    : `skipped: ${state.reason}`;
}

export interface RemoteListItem {
  label: string;
  description?: string;
  detail?: string;
  /** Undefined for the "Add" item. */
  name?: string;
  url?: string;
}

/** Items for Manage Remote Upstreams: "Add" first, then each configured remote with its state. */
export function remoteListItems(
  configured: { name: string; url: string }[],
  states: RemoteState[],
): RemoteListItem[] {
  return [
    {
      label: "$(add) Add remote upstream...",
      detail: "Use another machine's shared gateway (e.g. a dev tunnel URL)",
    },
    ...configured.map((r) => ({
      label: r.name,
      description: remoteStateText(states.find((s) => s.name === r.name)),
      detail: r.url,
      name: r.name,
      url: r.url,
    })),
  ];
}

export function configuredRemotes(
  current: unknown,
): { name: string; url: string }[] {
  return (Array.isArray(current) ? current : []).flatMap((e) => {
    const r = e as { name?: unknown; url?: unknown } | null;
    return typeof r?.name === "string"
      ? [{ name: r.name, url: typeof r.url === "string" ? r.url : "" }]
      : [];
  });
}

async function probe(name: string, url: string, apiKey: string | undefined) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Probing ${url}...`,
    },
    () =>
      discoverRemote(
        { name, url },
        { apiKey, validate: validateModelInfo, attempts: 1 },
      ),
  );
}

export async function setRemoteApiKey(
  context: vscode.ExtensionContext,
  gw: Gateway,
  target?: string,
): Promise<void> {
  const names = gw.remoteNames();
  if (names.length === 0) {
    void vscode.window.showWarningMessage(
      "No remote upstreams are configured.",
    );
    return;
  }
  const name =
    target ??
    (await vscode.window.showQuickPick(names, { title: "Remote upstream" }));
  if (!name) {
    return;
  }
  const value = await vscode.window.showInputBox({
    prompt: `API key for remote '${name}'. Leave empty to remove the stored value.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  if (value.trim() === "") {
    await context.secrets.delete(remoteApiKeySecretKey(name));
    void vscode.window.showInformationMessage("Stored key removed.");
  } else {
    await context.secrets.store(remoteApiKeySecretKey(name), value.trim());
    void vscode.window.showInformationMessage("Key stored.");
  }
  await gw.restart();
}

async function testRemote(
  context: vscode.ExtensionContext,
  name: string,
  url: string,
): Promise<void> {
  const apiKey =
    (await context.secrets.get(remoteApiKeySecretKey(name))) || undefined;
  const result = await probe(name, url, apiKey);
  if (result.state.status === "ready") {
    void vscode.window.showInformationMessage(
      `${name}: found ${result.models.length} models at ${url}.`,
    );
  } else {
    void vscode.window.showWarningMessage(
      `${name}: could not load models from ${url}: ${result.state.reason ?? "unknown reason"}`,
    );
  }
}

async function changeRemoteUrl(
  context: vscode.ExtensionContext,
  name: string,
  oldUrl: string,
): Promise<void> {
  const raw = await vscode.window.showInputBox({
    title: `Change URL of '${name}'`,
    value: oldUrl,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const r = validateRemoteUrl(v);
      return "error" in r ? r.error : undefined;
    },
  });
  if (raw === undefined) {
    return;
  }
  const parsed = validateRemoteUrl(raw);
  if ("error" in parsed || parsed.url === oldUrl) {
    return;
  }
  const url = parsed.url;
  const apiKey =
    (await context.secrets.get(remoteApiKeySecretKey(name))) || undefined;
  const result = await probe(name, url, apiKey);
  if (result.state.status !== "ready") {
    const save = await vscode.window.showWarningMessage(
      `Could not load models from '${name}' at ${url}: ${result.state.reason ?? "unknown reason"}`,
      { modal: true },
      "Save anyway",
    );
    if (save !== "Save anyway") {
      return;
    }
  }
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.inspect<unknown[]>("remoteUpstreams")?.globalValue;
  await config.update(
    "remoteUpstreams",
    mergeRemote(current, { name, url }).value,
    vscode.ConfigurationTarget.Global,
  );
  logger.info(`Changed URL of remote upstream '${name}' to ${url}.`);
  void vscode.window.showInformationMessage(`${name} now points at ${url}.`);
}

export async function manageRemoteUpstreams(
  context: vscode.ExtensionContext,
  gw: Gateway,
): Promise<void> {
  const current = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .inspect<unknown[]>("remoteUpstreams")?.globalValue;
  const picked = await vscode.window.showQuickPick(
    remoteListItems(configuredRemotes(current), gw.health().remotes),
    { title: "Manage Remote Upstreams" },
  );
  if (!picked) {
    return;
  }
  if (!picked.name) {
    return addRemoteUpstream(context);
  }
  const { name, url = "" } = picked;
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(plug) Test connection", id: "test" },
      { label: "$(key) Set / remove API key", id: "key" },
      { label: "$(link) Change URL", id: "url" },
      { label: "$(trash) Remove", id: "remove" },
    ],
    { title: `Remote upstream '${name}' (${url})` },
  );
  switch (action?.id) {
    case "test":
      return testRemote(context, name, url);
    case "key":
      return setRemoteApiKey(context, gw, name);
    case "url":
      return changeRemoteUrl(context, name, url);
    case "remove":
      return removeRemoteUpstream(context, name);
  }
}

function configuredRemoteNames(current: unknown): string[] {
  return (Array.isArray(current) ? current : [])
    .map((e) => (e as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string");
}

export async function addRemoteUpstream(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.inspect<unknown[]>("remoteUpstreams")?.globalValue;
  const existing = configuredRemoteNames(current);
  const rawUrl = await vscode.window.showInputBox({
    title: "Add Remote Upstream (1/3)",
    prompt: "Remote gateway URL, e.g. a dev tunnel URL",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const r = validateRemoteUrl(v);
      return "error" in r ? r.error : undefined;
    },
  });
  if (rawUrl === undefined) {
    return;
  }
  const parsed = validateRemoteUrl(rawUrl);
  if ("error" in parsed) {
    return;
  }
  const url = parsed.url;
  const name = await vscode.window.showInputBox({
    title: "Add Remote Upstream (2/3)",
    prompt: "Name (models appear as <name>--<modelId>)",
    value: deriveRemoteName(url),
    ignoreFocusOut: true,
    validateInput: (v) => validateRemoteName(v, existing, true),
  });
  if (!name) {
    return;
  }
  if (existing.includes(name)) {
    const replace = await vscode.window.showWarningMessage(
      `A remote named '${name}' already exists. Replace its URL with ${url}?`,
      { modal: true },
      "Replace",
    );
    if (replace !== "Replace") {
      return;
    }
  }
  const apiKey = await vscode.window.showInputBox({
    title: "Add Remote Upstream (3/3)",
    prompt: "API key of the remote gateway (leave empty if none)",
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) {
    return;
  }
  const key = apiKey.trim() || undefined;
  const probe = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Probing ${url}...`,
    },
    () =>
      discoverRemote(
        { name, url },
        { apiKey: key, validate: validateModelInfo, attempts: 1 },
      ),
  );
  if (probe.state.status === "ready") {
    void vscode.window.showInformationMessage(
      `Found ${probe.models.length} models on ${name}.`,
    );
  } else {
    const reason = probe.state.reason ?? "unknown reason";
    logger.warn(`Probe of remote '${name}' (${url}) failed: ${reason}`);
    const save = await vscode.window.showWarningMessage(
      `Could not load models from '${name}' at ${url}: ${reason}`,
      { modal: true },
      "Save anyway",
    );
    if (save !== "Save anyway") {
      return;
    }
  }
  if (key) {
    await context.secrets.store(remoteApiKeySecretKey(name), key);
  } else {
    await context.secrets.delete(remoteApiKeySecretKey(name));
  }
  await config.update(
    "remoteUpstreams",
    mergeRemote(current, { name, url }).value,
    vscode.ConfigurationTarget.Global,
  );
  logger.info(`Added remote upstream '${name}' (${url}).`);
  void vscode.window.showInformationMessage(
    `Added ${name}: models appear as ${name}--<modelId>`,
  );
}

export async function removeRemoteUpstream(
  context: vscode.ExtensionContext,
  target?: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.inspect<unknown[]>("remoteUpstreams")?.globalValue;
  const names = configuredRemoteNames(current);
  if (names.length === 0) {
    void vscode.window.showWarningMessage(
      "No remote upstreams are configured in user settings.",
    );
    return;
  }
  const name =
    target && names.includes(target)
      ? target
      : await vscode.window.showQuickPick(names, {
          title: "Remove remote upstream",
        });
  if (!name) {
    return;
  }
  await config.update(
    "remoteUpstreams",
    removeRemote(current, name),
    vscode.ConfigurationTarget.Global,
  );
  await context.secrets.delete(remoteApiKeySecretKey(name));
  logger.info(`Removed remote upstream '${name}'.`);
  void vscode.window.showInformationMessage(`Removed ${name}.`);
}
