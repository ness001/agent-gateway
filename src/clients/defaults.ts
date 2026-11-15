import type { ClientConfigInput, GatewayModel } from "./types";

export const GATEWAY_PROVIDER_ID = "agent-gateway";
export const GATEWAY_PROVIDER_NAME = "Agent Gateway";
export const PLACEHOLDER_API_KEY = "local-gateway-client";

export const gatewayApiKey = (input: ClientConfigInput): string =>
  input.apiKey || PLACEHOLDER_API_KEY;
export const gatewayV1Url = (input: ClientConfigInput): string =>
  `${input.gatewayUrl.replace(/\/+$/, "")}/v1`;
export const manualApiKey = (input: ClientConfigInput): string =>
  input.apiKey ? "<your gateway API key>" : PLACEHOLDER_API_KEY;
export const toolModels = (models: GatewayModel[]): GatewayModel[] =>
  models.filter((model) => model.supportsToolCalling !== false);
export const agentModels = (models: GatewayModel[]): GatewayModel[] =>
  toolModels(models).filter(
    (model) =>
      !["copilot-utility", "copilot-dictation"].some((prefix) =>
        model.id.startsWith(prefix),
      ),
  );

/** Shared gateway policy; restoration snapshots belong to each adapter, not here. */
export const CLIENT_DEFAULTS = {
  modelStateKey: "agentGateway.configureClients.defaultModel",
  claudeOutputTokens: "128000",
  claudeModelDiscovery: "1",
  claudeAutoModeServer: "0",
  codex: {
    wireApi: "responses",
    discovery: true,
    proxyPlatform: "darwin",
    webSearch: "live",
  },
  omp: {
    api: "openai-responses",
    discovery: { type: "openai-models-list", injectV1: false },
  },
  pi: { api: "openai-responses" },
  openclaw: { mode: "merge", api: "anthropic-messages" },
  hermes: { transport: "chat_completions", discoverModels: true },
  deepseekHarness: { api: "anthropic-messages" },
  kilo: { npm: "@ai-sdk/openai-compatible" },
} as const;

/** The picker and status checks must resolve the same shared target. */
export function sharedDefaultModel(
  models: GatewayModel[],
  saved?: string,
): GatewayModel | undefined {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  return (
    sorted.find((m) => m.id === saved) ??
    sorted.find((m) => m.id.startsWith("claude-")) ??
    sorted[0]
  );
}
