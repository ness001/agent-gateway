import type { ErrorRecord } from "./errorJournal";
import type { RemoteState } from "./types";

export type GatewayStatus =
  | "Starting"
  | "Ready"
  | "Waiting for Copilot"
  | "Port conflict"
  | "Error"
  | "Disabled";

export interface HealthSnapshot {
  status: GatewayStatus;
  bridgeVersion: string;
  /** Build time of the running bundle, to confirm a reinstall was loaded. */
  buildTime: string;
  listener: { active: boolean; address: string | null };
  vscodeVersion: string;
  copilot: { installed: boolean; active: boolean };
  modelCount: number;
  lastDiscoveryTime: string | null;
  lastStartupError: string | null;
  remotes: RemoteState[];
  /** Model used for unknown non-Gemini model names; null when none. */
  fallbackModel: string | null;
  fallbackModelSource: "setting" | "default" | null;
  /** Metadata-only failures since the gateway was activated. */
  errors: { counts: Record<string, number>; recent: ErrorRecord[] };
}

/** Strip anything that looks like a filesystem path or credential from an error message. */
export function sanitizeError(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s'"]*/g, "<path>")
    .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]*/g, "<path>")
    .replace(/(bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/((?:api[-_]?key|key|token)[=:]\s*)\S+/gi, "$1<redacted>")
    .slice(0, 500);
}
