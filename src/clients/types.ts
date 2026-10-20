// Contract for "Configure Coding Agents". Adapters are pure: they read and
// return file text so they can be unit-tested without vscode or the disk.

export interface GatewayModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens?: number;
  inputModalities: string[];
  supportsToolCalling: boolean | null;
  reasoning: boolean;
}

export interface ClientConfigInput {
  /** Gateway origin without trailing slash, e.g. http://127.0.0.1:24444. */
  gatewayUrl: string;
  /** Gateway API key when one is set; adapters write a placeholder otherwise. */
  apiKey?: string;
  /** Advertised gateway models (local + remote, no aliases). */
  models: GatewayModel[];
  /** Model the user picked as the client's default. */
  defaultModel: string;
  /** Absolute path of the user's home directory. */
  home: string;
  platform: NodeJS.Platform;
}

export interface PlannedFileChange {
  path: string;
  /** Current text, or undefined when the file does not exist. */
  before: string | undefined;
  /** New text; undefined means delete the file. */
  after: string | undefined;
}

export interface ClientPlan {
  changes: PlannedFileChange[];
  /** One-line human summaries shown before applying. */
  summary: string[];
  /** Manual steps when the client cannot be configured from files (Cursor). */
  manualSteps?: string[];
  /** Text to copy to the clipboard for manual steps. */
  clipboard?: string;
  /** Follow-up shown after applying, e.g. "Restart Codex". */
  afterApply?: string;
}

export interface ClientAdapter {
  id: string;
  label: string;
  /** "auto" = client lists models from /v1/models; "static" = list written into config; "single" = one model; "manual". */
  discovery: "auto" | "static" | "single" | "manual";
  /** Notes about behaviour that is documented but not verified live. */
  caveat?: string;
  /** Config paths whose existence suggests the client is installed. */
  detectPaths(home: string, platform: NodeJS.Platform): string[];
  /** Files the plan reads (so the caller can load them). */
  configPaths(home: string, platform: NodeJS.Platform): string[];
  /** Build the change from current file contents keyed by path. */
  plan(
    input: ClientConfigInput,
    files: Record<string, string | undefined>,
  ): ClientPlan;
  /** Remove only what plan() added; returns the reverting change. */
  unplan(
    input: ClientConfigInput,
    files: Record<string, string | undefined>,
  ): ClientPlan;
}

/** Provider/entry name written into every client config. */
export const GATEWAY_PROVIDER_ID = "agent-gateway";
export const GATEWAY_PROVIDER_NAME = "Agent Gateway";
/** Written when the gateway has no API key; the gateway strips caller credentials. */
export const PLACEHOLDER_API_KEY = "local-gateway-client";
