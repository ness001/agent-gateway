import { dedupeModels, fromOpenAIModel } from "./discovery";
import type { ModelInfo, RemoteState, RemoteUpstreamConfig } from "./types";
import { MODEL_DISCOVERY_HEADER } from "./types";

const MODELS_PATH = "/v1/models";
const NOT_SUPPORTED = "not an Agent Gateway or OpenAI-compatible server";

// Reasons are built only from fixed text and status codes, never from
// response bodies or fetch error messages.
class DiscoveryError extends Error {
  constructor(
    readonly reason: string,
    readonly transient: boolean,
  ) {
    super(reason);
  }
}

export interface DiscoverRemoteOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  attemptTimeoutMs?: number;
  retryDelayMs?: number;
}

export async function discoverRemote(
  remote: RemoteUpstreamConfig,
  opts: DiscoverRemoteOptions,
): Promise<{ state: RemoteState; models: ModelInfo[] }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  let lastReason = "Unexpected discovery failure.";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const models = parseModelList(await fetchModelList(remote, opts));
      return {
        state: {
          name: remote.name,
          url: remote.url,
          status: "ready",
          modelCount: models.length,
        },
        models,
      };
    } catch (error) {
      const failure =
        error instanceof DiscoveryError
          ? error
          : new DiscoveryError("Unexpected discovery failure.", false);
      lastReason = failure.reason;
      if (!failure.transient || attempt === attempts) {
        break;
      }
      await delay(retryDelayMs);
    }
  }
  return {
    state: {
      name: remote.name,
      url: remote.url,
      status: "skipped",
      reason: lastReason,
    },
    models: [],
  };
}

async function fetchModelList(
  remote: RemoteUpstreamConfig,
  opts: DiscoverRemoteOptions,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.attemptTimeoutMs ?? 10_000;
  const headers: Record<string, string> = {
    accept: "application/json",
    [MODEL_DISCOVERY_HEADER]: "1",
  };
  if (opts.apiKey) {
    headers.authorization = `Bearer ${opts.apiKey}`;
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${remote.url}${MODELS_PATH}`, {
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      throw timedOut
        ? timeoutError(timeoutMs)
        : new DiscoveryError(networkReason(error), true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      throw new DiscoveryError(
        `GET ${MODELS_PATH} returned HTTP ${status}: ${statusHint(status)}`,
        status === 408 || status === 429 || (status >= 500 && status <= 599),
      );
    }
    try {
      return await response.json();
    } catch {
      if (timedOut) {
        throw timeoutError(timeoutMs);
      }
      throw new DiscoveryError(
        `GET ${MODELS_PATH} returned invalid JSON: ${NOT_SUPPORTED}.`,
        false,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseModelList(body: unknown): ModelInfo[] {
  const data =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).data
      : undefined;
  if (!Array.isArray(data)) {
    throw new DiscoveryError(
      `GET ${MODELS_PATH} returned an unexpected document: ${NOT_SUPPORTED}.`,
      false,
    );
  }
  const models: ModelInfo[] = [];
  for (const entry of data) {
    try {
      models.push(fromOpenAIModel(entry));
    } catch {
      // Skip unusable entries; third-party lists are not strictly validated.
    }
  }
  if (data.length > 0 && models.length === 0) {
    throw new DiscoveryError(
      `GET ${MODELS_PATH} returned no valid model entries.`,
      false,
    );
  }
  return dedupeModels(models);
}

function statusHint(status: number): string {
  if (status === 401) {
    return "the remote gateway requires an API key; set one for this remote.";
  }
  if (status === 403) {
    return "the API key for this remote is invalid.";
  }
  if (status === 404) {
    return `tunnel missing or ${NOT_SUPPORTED}`;
  }
  if (status === 502 || status === 503 || status === 504) {
    return "the tunnel host or remote gateway is not serving; check devtunnel host and VS Code on that machine.";
  }
  if (status >= 300 && status < 400) {
    return "the URL redirects; use the gateway origin directly.";
  }
  return "check the remote gateway.";
}

function timeoutError(timeoutMs: number): DiscoveryError {
  return new DiscoveryError(
    `No response within ${Math.round(timeoutMs / 1000)} seconds.`,
    true,
  );
}

function networkReason(error: unknown): string {
  const code = findCode(error);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The host name could not be resolved.";
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "UND_ERR_SOCKET":
      return "The connection was refused or unreachable; check that the remote gateway is running.";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "The connection timed out.";
    default:
      if (code && /CERT|TLS|SSL/i.test(code)) {
        return "The TLS connection failed.";
      }
      return "The connection failed.";
  }
}

function findCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
