// Shared contracts between catalogue, matching, remote upstreams, and the HTTP app.
// Keep this file free of `vscode` imports so pure modules stay unit-testable in Node.

export type ProtocolOperation =
  | "anthropic.messages"
  | "anthropic.countTokens"
  | "openai.responses"
  | "openai.chatCompletions"
  | "gemini.generateContent"
  | "gemini.streamGenerateContent"
  | "gemini.countTokens";

export const ALL_OPERATIONS: readonly ProtocolOperation[] = [
  "anthropic.messages",
  "anthropic.countTokens",
  "openai.responses",
  "openai.chatCompletions",
  "gemini.generateContent",
  "gemini.streamGenerateContent",
  "gemini.countTokens",
];

export interface ReasoningLevel {
  effort: string;
  description: string;
}

/** Normalised metadata for one model, local or remote. */
export interface ModelInfo {
  /** ID accepted by the owning gateway (`selectChatModels` ID for local models). */
  id: string;
  displayName: string;
  family?: string;
  version?: string;
  vendor?: string;
  contextWindow: number | null;
  inputModalities: string[];
  supportsToolCalling: boolean | null;
  defaultReasoningLevel: string;
  supportedReasoningLevels: ReasoningLevel[];
  operations: ProtocolOperation[];
}

/** One advertised catalogue entry (native or alias). */
export interface CatalogEntry extends ModelInfo {
  /** Advertised ID: `{modelId}`, `{name}--{modelId}`, or `gateway-claude-...`. */
  id: string;
  /** ID on the owning gateway. */
  upstreamModelId: string;
  /** Remote upstream name, or undefined for local models. */
  remote?: string;
  isAlias: boolean;
}

export interface RemoteUpstreamConfig {
  name: string;
  /** Normalised origin without trailing slash. */
  url: string;
}

export type RemoteState =
  | { name: string; url: string; status: "ready"; modelCount: number }
  | { name: string; url: string; status: "skipped"; reason: string };

/** `GET /v1/gateway/catalog` response body. */
export interface GatewayCatalogResponse {
  version: 1;
  models: ModelInfo[];
}

export const GATEWAY_CATALOG_VERSION = 1;
