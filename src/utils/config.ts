import * as vscode from "vscode";

import type { RemoteUpstreamConfig } from "../gateway/types";
import {
  DEFAULT_MAX_SEARCHES_PER_REQUEST,
  clampMaxSearchesPerRequest,
} from "../protocol/hosted/catalog";

export type GatewayLogLevel = "error" | "warn" | "info" | "debug";
export type WebSearchProviderName =
  | "none"
  | "exa"
  | "firecrawl"
  | "tavily"
  | "jina"
  | "you";

export interface GatewayConfiguration {
  enabled: boolean;
  port: number;
  logLevel: GatewayLogLevel;
  remoteUpstreams: RemoteUpstreamConfig[];
  /** Requested model -> local model ID; an empty value disables a built-in alias. */
  modelMappings: Record<string, string>;
  /** Model for unknown non-Gemini names; empty disables fallback. */
  fallbackModel: string;
  webSearch: {
    provider: WebSearchProviderName;
    model: string;
    maxSearchesPerRequest: number;
  };
}

export const CONFIG_SECTION = "agentGateway";

export const DEFAULT_CONFIG: GatewayConfiguration = {
  enabled: true,
  port: 24444,
  logLevel: "info",
  remoteUpstreams: [],
  modelMappings: { "claude-haiku-5.5": "", "claude-sonnet-5": "" },
  fallbackModel: "",
  webSearch: {
    provider: "none",
    model: "",
    maxSearchesPerRequest: DEFAULT_MAX_SEARCHES_PER_REQUEST,
  },
};

/** Keeps only string values; anything else is ignored. */
export const readModelAliases = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const [key, target] of Object.entries(value)) {
    if (typeof target === "string" && key.trim()) {
      aliases[key] = target;
    }
  }
  return aliases;
};

export const readConfiguration = (): GatewayConfiguration => {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get<boolean>("enabled", DEFAULT_CONFIG.enabled),
    port: config.get<number>("port", DEFAULT_CONFIG.port),
    logLevel: config.get<GatewayLogLevel>("logLevel", DEFAULT_CONFIG.logLevel),
    remoteUpstreams: config.get<RemoteUpstreamConfig[]>(
      "remoteUpstreams",
      DEFAULT_CONFIG.remoteUpstreams,
    ),
    modelMappings: readModelAliases(config.get<unknown>("modelMappings", {})),
    fallbackModel: config.get<string>(
      "fallbackModel",
      DEFAULT_CONFIG.fallbackModel,
    ),
    webSearch: {
      provider: config.get<WebSearchProviderName>(
        "webSearch.provider",
        DEFAULT_CONFIG.webSearch.provider,
      ),
      model: config.get<string>(
        "webSearch.model",
        DEFAULT_CONFIG.webSearch.model,
      ),
      maxSearchesPerRequest: clampMaxSearchesPerRequest(
        config.get<number>(
          "webSearch.maxSearchesPerRequest",
          DEFAULT_CONFIG.webSearch.maxSearchesPerRequest,
        ),
      ),
    },
  };
};
