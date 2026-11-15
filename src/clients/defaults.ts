import type { GatewayModel } from "./types";

/** Shared gateway policy; restoration snapshots belong to each adapter, not here. */
export const CLIENT_DEFAULTS = {
  modelStateKey: "agentGateway.configureClients.defaultModel",
  claudeOutputTokens: "128000",
  claudeModelDiscovery: "1",
  claudeAutoModeServer: "0",
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
