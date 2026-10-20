import type { ModelInfo, RemoteState, RemoteUpstreamConfig } from "./types";
import { GATEWAY_CATALOG_VERSION } from "./types";

const CATALOG_PATH = "/v1/gateway/catalog";

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
  validate: (m: unknown) => ModelInfo;
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
      const models = await fetchCatalog(remote, opts);
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

async function fetchCatalog(
  remote: RemoteUpstreamConfig,
  opts: DiscoverRemoteOptions,
): Promise<ModelInfo[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.attemptTimeoutMs ?? 10_000;
  const headers: Record<string, string> = { accept: "application/json" };
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
      response = await fetchImpl(`${remote.url}${CATALOG_PATH}`, {
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
        `GET ${CATALOG_PATH} returned HTTP ${status}: ${statusHint(status)}`,
        status === 408 || status === 429 || (status >= 500 && status <= 599),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (timedOut) {
        throw timeoutError(timeoutMs);
      }
      throw new DiscoveryError(
        `GET ${CATALOG_PATH} returned invalid JSON: not an Agent Gateway.`,
        false,
      );
    }
    return parseCatalog(body, opts.validate);
  } finally {
    clearTimeout(timer);
  }
}

function parseCatalog(
  body: unknown,
  validate: (m: unknown) => ModelInfo,
): ModelInfo[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DiscoveryError(
      `GET ${CATALOG_PATH} returned an unexpected document: not an Agent Gateway.`,
      false,
    );
  }
  const { version, models } = body as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new DiscoveryError(
      `GET ${CATALOG_PATH} returned no catalogue version: not an Agent Gateway.`,
      false,
    );
  }
  if (version !== GATEWAY_CATALOG_VERSION) {
    throw new DiscoveryError(
      `GET ${CATALOG_PATH} returned unsupported catalogue version ${version} (expected ${GATEWAY_CATALOG_VERSION}); update the extension on both machines.`,
      false,
    );
  }
  if (!Array.isArray(models)) {
    throw new DiscoveryError(
      `GET ${CATALOG_PATH} returned a catalogue without a models array.`,
      false,
    );
  }
  try {
    return models.map((m) => validate(m));
  } catch {
    throw new DiscoveryError(
      `GET ${CATALOG_PATH} returned an invalid model entry.`,
      false,
    );
  }
}

function statusHint(status: number): string {
  if (status === 401) {
    return "the remote gateway requires an API key; set one for this remote.";
  }
  if (status === 403) {
    return "the API key for this remote is invalid.";
  }
  if (status === 404) {
    return "tunnel missing or not an Agent Gateway";
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
