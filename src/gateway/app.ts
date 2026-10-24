import { Hono } from "hono";
import type { Context } from "hono";

import { attachParsedBody, lazyBody } from "../protocol/http/body";
import {
  createCodexModelsResponse,
  createGatewayCatalog,
  createModelsResponse,
} from "./catalog";
import {
  checkApiKey,
  extractPresentedApiKey,
  hasTunnelForwardingHeaders,
  stripCallerCredentials,
  stripGeminiKeyQuery,
} from "./credentials";
import type { ErrorJournal } from "./errorJournal";
import { RemoteUnavailableError, forwardToRemote } from "./forward";
import {
  explainUnknownModel,
  isValidGeminiModelSegment,
  resolveModel,
  resolveModelAlias,
} from "./match";
import {
  ANTHROPIC_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  type RequestContext,
  currentRequestContext,
  requestIdFrom,
  runWithRequestContext,
} from "./requestContext";
import type {
  CatalogEntry,
  ModelInfo,
  ProtocolOperation,
  RemoteState,
  RemoteUpstreamConfig,
} from "./types";

export type Protocol = "openai" | "anthropic" | "gemini" | "gateway";

export interface GatewayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface GatewayAppDeps {
  getRegistry: () => CatalogEntry[];
  /** Local (non-remote, deduplicated) models for `/v1/gateway/catalog`. */
  getLocalModels: () => ModelInfo[];
  /**
   * Handles a local inference request whose model has already been rewritten
   * to the upstream ID. Production wires this to the borrowed bridge routes.
   */
  handleLocal: (request: Request) => Promise<Response>;
  getRemote: (name: string) => RemoteUpstreamConfig | undefined;
  getRemoteApiKey: (name: string) => Promise<string | undefined>;
  getApiKey: () => Promise<string | undefined>;
  getHealth: () => unknown;
  logger: GatewayLogger;
  /** Remote discovery states, used to explain unknown or fallback models. */
  getRemoteStates?: () => RemoteState[];
  /** Records failed requests (metadata only) for /health and the error log. */
  errorJournal?: ErrorJournal;
  fetchImpl?: typeof fetch;
  /** `agentGateway.webSearch.model`; empty picks a local Gemini model. */
  getWebSearchModel?: () => string | undefined;
  /** `agentGateway.modelAliases` (requested model -> local model). */
  getModelAliases?: () => Record<string, unknown> | undefined;
  /** `agentGateway.fallbackModel`; empty uses `gpt-6-astra`. */
  getFallbackModel?: () => string | undefined;
}

const MODEL_ALIAS_REASON = "model alias";

/**
 * True when every declared Gemini tool is hosted Google Search. Gemini CLI
 * sends such side requests on its own internal model ID.
 */
const isGeminiHostedSearchOnly = (body: unknown): boolean => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const tools = (body as Record<string, unknown>).tools;
  return (
    Array.isArray(tools) &&
    tools.length > 0 &&
    tools.every(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        !Array.isArray(tool) &&
        Object.keys(tool).length > 0 &&
        Object.keys(tool).every(
          (key) => key === "googleSearch" || key === "googleSearchRetrieval",
        ),
    )
  );
};

const protocolForOperation = (operation: ProtocolOperation): string =>
  operation.split(".")[0];

const GEMINI_PATH =
  /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

const OPENAI_PATHS = new Set(["/v1/responses", "/v1/chat/completions"]);
const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const PATH_OPERATIONS: Record<string, ProtocolOperation> = {
  "/v1/messages": "anthropic.messages",
  "/v1/messages/count_tokens": "anthropic.countTokens",
  "/v1/responses": "openai.responses",
  "/v1/chat/completions": "openai.chatCompletions",
};

const GET_PATHS = new Set(["/v1/models", "/health", "/v1/gateway/catalog"]);

export const protocolForPath = (path: string): Protocol => {
  if (OPENAI_PATHS.has(path)) {
    return "openai";
  }
  if (ANTHROPIC_PATHS.has(path)) {
    return "anthropic";
  }
  if (path.startsWith("/v1beta/")) {
    return "gemini";
  }
  return "gateway";
};

const geminiStatus = (status: number): string => {
  switch (status) {
    case 400:
    case 413:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 503:
      return "UNAVAILABLE";
    default:
      return "INTERNAL";
  }
};

const anthropicType = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 504:
      return "timeout_error";
    case 413:
      return "request_too_large";
    case 503:
    case 502:
      return "api_error";
    case 500:
      return "api_error";
    default:
      return "invalid_request_error";
  }
};

const openaiType = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 429:
      return "rate_limit_error";
    case 404:
      return "invalid_request_error";
    case 500:
    case 502:
    case 503:
      return "server_error";
    default:
      return "invalid_request_error";
  }
};

export function errorResponse(
  protocol: Protocol,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  // The request ID lets users match a client-side error to the gateway log.
  const requestId = currentRequestContext()?.requestId;
  const idField = requestId ? { request_id: requestId } : {};
  let body: unknown;
  if (protocol === "anthropic") {
    body = {
      type: "error",
      error: { type: anthropicType(status), message },
      ...idField,
    };
  } else if (protocol === "gemini") {
    body = {
      error: { code: status, message, status: geminiStatus(status) },
      ...idField,
    };
  } else {
    body = {
      error: { message, type: openaiType(status), param: null, code: null },
      ...idField,
    };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Model IDs are client-supplied; JSON-escape them so logs cannot be forged.
const logId = (value: string): string => JSON.stringify(value);

export const MODEL_HEADER = "x-agent-gateway-model";
export const FALLBACK_HEADER = "x-agent-gateway-model-fallback";

/** Drops CR/LF, control and non-ASCII characters so values cannot split headers. */
export const headerSafe = (value: string): string =>
  value.replace(/[^ -~]/g, "").slice(0, 512);

const unknownModelMessage = (model: string, reason: string): string =>
  `Unknown model ${logId(model)}: ${reason}. Use GET /v1/models to list available models.`;

function withHeaders(
  response: Response,
  extra: Record<string, string>,
): Response {
  try {
    for (const [k, v] of Object.entries(extra)) {
      response.headers.set(k, v);
    }
    return response;
  } catch {
    // Immutable headers (e.g. a fetch Response): rebuild around the same body.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(extra)) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export function createGatewayApp(deps: GatewayAppDeps): Hono {
  const app = new Hono();
  let tunnelWarningShown = false;

  app.use("*", async (c, next) => {
    const id = requestIdFrom(c.req.raw.headers);
    const started = Date.now();
    const protocol = protocolForPath(c.req.path);
    const context: RequestContext = {
      requestId: id,
      protocol,
      path: c.req.path,
    };
    c.set("requestId" as never, id as never);
    await runWithRequestContext(context, () => next());
    // Reassigning c.res makes Hono rebuild the response; only do it when the
    // headers are immutable (a passed-through fetch Response).
    try {
      c.res.headers.set(REQUEST_ID_HEADER, id);
      c.res.headers.set(ANTHROPIC_REQUEST_ID_HEADER, id);
    } catch {
      c.res = withHeaders(c.res, {
        [REQUEST_ID_HEADER]: id,
        [ANTHROPIC_REQUEST_ID_HEADER]: id,
      });
    }
    const selected = c.get("selectedModel" as never) as string | undefined;
    const elapsedMs = Date.now() - started;
    const status = c.res.status;
    deps.logger.info(
      `[${id}] ${protocol} ${c.req.method} ${c.req.path}${
        selected ? ` model=${logId(selected)}` : ""
      } status=${status}${context.errorKind ? ` kind=${context.errorKind}` : ""} ${elapsedMs}ms`,
    );
    if (status >= 400) {
      deps.errorJournal?.record({
        time: new Date().toISOString(),
        requestId: id,
        protocol,
        method: c.req.method,
        path: c.req.path,
        status,
        ...(selected && { model: selected }),
        ...(context.errorKind && { kind: context.errorKind }),
        ...(context.providerCode && { providerCode: context.providerCode }),
        ...(context.remote && { remote: context.remote }),
        elapsedMs,
      });
    }
  });

  app.use("*", async (c, next) => {
    const protocol = protocolForPath(c.req.path);
    const raw = c.req.raw;
    const url = new URL(raw.url);
    const configured = await deps.getApiKey();
    if (configured) {
      const presented = extractPresentedApiKey(raw.headers, url.search);
      if (!checkApiKey(configured, presented)) {
        return errorResponse(protocol, 401, "Invalid or missing API key.");
      }
    } else if (!tunnelWarningShown && hasTunnelForwardingHeaders(raw.headers)) {
      tunnelWarningShown = true;
      deps.logger.warn(
        "Request arrived through a forwarding proxy (for example a dev tunnel) while no gateway API key is set. Anyone with the tunnel URL can use this host's Copilot quota; run 'Agent Gateway: Share Gateway via Dev Tunnel' and set an API key.",
      );
    }
    // Replace the request so no handler can see caller credentials.
    const cleanUrl = `${url.origin}${url.pathname}${stripGeminiKeyQuery(url.search)}`;
    const hasBody = raw.method !== "GET" && raw.method !== "HEAD";
    c.req.raw = new Request(cleanUrl, {
      method: raw.method,
      headers: stripCallerCredentials(raw.headers),
      body: hasBody ? raw.body : undefined,
      signal: raw.signal,
      // Required by Node's fetch when streaming a request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    await next();
  });

  app.all("*", async (c) => {
    const path = c.req.path;
    const method = c.req.method;
    const protocol = protocolForPath(path);

    if (GET_PATHS.has(path)) {
      if (method !== "GET") {
        return errorResponse("openai", 405, `${path} requires GET.`, {
          Allow: "GET",
        });
      }
      if (path === "/v1/models") {
        const reg = deps.getRegistry();
        return c.json(
          c.req.query("client_version")
            ? createCodexModelsResponse(reg)
            : createModelsResponse(reg),
        );
      }
      if (path === "/health") {
        return c.json(deps.getHealth() as object);
      }
      return c.json(createGatewayCatalog(deps.getLocalModels()));
    }

    if (protocol === "gateway") {
      return errorResponse("openai", 404, `Unsupported route: ${path}`);
    }

    if (protocol === "gemini") {
      const match = GEMINI_PATH.exec(path);
      if (!match) {
        return errorResponse("gemini", 404, "Unsupported Gemini route.");
      }
      if (method !== "POST") {
        return errorResponse("gemini", 405, "Gemini operations require POST.", {
          Allow: "POST",
        });
      }
      let model: string;
      try {
        model = decodeURIComponent(match[1]);
      } catch {
        return errorResponse("gemini", 400, "Invalid Gemini model ID.");
      }
      if (!isValidGeminiModelSegment(model)) {
        return errorResponse("gemini", 400, "Invalid Gemini model ID.");
      }
      const operation = `gemini.${match[2]}` as ProtocolOperation;
      const aliased = await aliasFor(model, operation, () =>
        isHostedSearchSideRequest(c, match[2]),
      );
      if (aliased) {
        return aliasedDispatch(c, protocol, model, aliased, {
          action: match[2],
        });
      }
      const resolved = resolveModel(deps.getRegistry(), model, {
        allowFallback: false,
      });
      if (!resolved) {
        return errorResponse(
          "gemini",
          404,
          unknownModelMessage(model, missingReason(model)),
        );
      }
      return dispatch(c, protocol, resolved.entry, { action: match[2] });
    }

    if (method !== "POST") {
      return errorResponse(protocol, 405, `${path} requires POST.`, {
        Allow: "POST",
      });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse(
        protocol,
        400,
        "Request body must be a JSON object.",
      );
    }
    const model = body.model;
    if (typeof model !== "string" || model.trim() === "") {
      return errorResponse(protocol, 400, "Request body must specify a model.");
    }
    const aliased = await aliasFor(
      model,
      PATH_OPERATIONS[path],
      async () => false,
    );
    if (aliased) {
      return aliasedDispatch(c, protocol, model, aliased, undefined, body);
    }
    const resolved = resolveModel(deps.getRegistry(), model, {
      allowFallback: true,
      remotes: remoteStates(),
      ...fallbackOptions(PATH_OPERATIONS[path]),
    });
    if (!resolved) {
      return errorResponse(
        protocol,
        400,
        unknownModelMessage(model, missingReason(model)),
      );
    }
    if (resolved.fallback) {
      const reason = resolved.reason ?? "unknown model";
      deps.logger.warn(
        `[${c.get("requestId" as never)}] Model fallback: requested ${logId(model)} -> using ${logId(resolved.entry.id)} (reason: ${reason})`,
      );
      const response = await dispatch(
        c,
        protocol,
        resolved.entry,
        undefined,
        body,
      );
      return withHeaders(response, {
        [FALLBACK_HEADER]: headerSafe(
          `${model} -> ${resolved.entry.id}; reason=${reason}`,
        ),
      });
    }
    return dispatch(c, protocol, resolved.entry, undefined, body);
  });

  /**
   * True for a Gemini hosted-search side request (tools are only
   * googleSearch/googleSearchRetrieval), which Gemini CLI sends on its own
   * internal model ID.
   */
  async function isHostedSearchSideRequest(
    c: Context,
    action: string,
  ): Promise<boolean> {
    if (action === "countTokens") {
      return false;
    }
    try {
      return isGeminiHostedSearchOnly(JSON.parse(await c.req.text()));
    } catch {
      return false;
    }
  }

  const safeRead = <T>(read: (() => T) | undefined): T | undefined => {
    try {
      return read?.();
    } catch {
      return undefined;
    }
  };

  const warnedFallbacks = new Set<string>();
  /** Fallback settings for a request; a missing model warns once per value. */
  const fallbackOptions = <T extends ProtocolOperation | undefined>(
    operation: T,
  ) => ({
    fallbackModel: safeRead(deps.getFallbackModel),
    operation,
    onMissingFallback: (id: string) => {
      if (!warnedFallbacks.has(id)) {
        warnedFallbacks.add(id);
        deps.logger.warn(
          `agentGateway.fallbackModel ${logId(id)} is not an available model; using the default fallback.`,
        );
      }
    },
  });

  /**
   * Model alias for a request: a user alias always applies (it may also
   * redirect an existing model); built-in Gemini CLI aliases and the
   * hosted-search rule apply only when the requested model has no route.
   */
  async function aliasFor(
    model: string,
    operation: ProtocolOperation,
    hostedSearch: () => Promise<boolean>,
  ): Promise<CatalogEntry | undefined> {
    const reg = deps.getRegistry();
    const userAliases = safeRead(deps.getModelAliases);
    const hasUserAlias =
      userAliases !== undefined &&
      Object.prototype.hasOwnProperty.call(userAliases, model);
    if (!hasUserAlias && resolveModel(reg, model, { allowFallback: false })) {
      return undefined;
    }
    if (!hasUserAlias && reg.filter((e) => e.id === model).length > 1) {
      return undefined;
    }
    const target = resolveModelAlias(reg, model, {
      userAliases,
      searchModel: safeRead(deps.getWebSearchModel),
      hostedSearch:
        !hasUserAlias && protocolForOperation(operation) === "gemini"
          ? await hostedSearch()
          : false,
      ...fallbackOptions(operation),
    });
    return target && target.id !== model ? target : undefined;
  }

  async function aliasedDispatch(
    c: Context,
    protocol: Protocol,
    model: string,
    entry: CatalogEntry,
    gemini: { action: string } | undefined,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    deps.logger.warn(
      `[${c.get("requestId" as never)}] Model fallback: requested ${logId(model)} -> using ${logId(entry.id)} (reason: ${MODEL_ALIAS_REASON})`,
    );
    const response = await dispatch(c, protocol, entry, gemini, body);
    return withHeaders(response, {
      [FALLBACK_HEADER]: headerSafe(
        `${model} -> ${entry.id}; reason=${MODEL_ALIAS_REASON}`,
      ),
    });
  }

  function remoteStates(): RemoteState[] {
    try {
      return deps.getRemoteStates?.() ?? [];
    } catch {
      return [];
    }
  }

  function missingReason(model: string): string {
    const reg = deps.getRegistry();
    if (reg.filter((e) => e.id === model).length > 1) {
      return "the model ID is ambiguous";
    }
    return explainUnknownModel(model, remoteStates());
  }

  async function dispatch(
    c: Context,
    protocol: Protocol,
    entry: CatalogEntry,
    gemini: { action: string } | undefined,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const response = await dispatchInner(c, protocol, entry, gemini, body);
    return withHeaders(response, {
      [MODEL_HEADER]: headerSafe(entry.upstreamModelId),
    });
  }

  async function dispatchInner(
    c: Context,
    protocol: Protocol,
    entry: CatalogEntry,
    gemini: { action: string } | undefined,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    c.set("selectedModel" as never, entry.id as never);
    const context = currentRequestContext();
    if (context) {
      context.model = entry.id;
    }
    const operation = gemini
      ? (`gemini.${gemini.action}` as ProtocolOperation)
      : PATH_OPERATIONS[c.req.path];
    // Mirrors the PowerShell supportedPaths check: never route an API the model does not advertise.
    if (!entry.operations.includes(operation)) {
      return errorResponse(
        protocol,
        400,
        "The upstream does not advertise this inference API.",
      );
    }
    const raw = c.req.raw;
    const url = new URL(raw.url);

    if (entry.remote !== undefined) {
      const remote = deps.getRemote(entry.remote);
      if (!remote) {
        return errorResponse(
          protocol,
          503,
          `Remote upstream '${entry.remote}' is not configured.`,
        );
      }
      let geminiBody: Record<string, unknown> | undefined;
      if (gemini) {
        try {
          geminiBody = (await c.req.json()) as Record<string, unknown>;
        } catch {
          return errorResponse(protocol, 400, "Request body must be JSON.");
        }
      }
      const reqId = c.get("requestId" as never) as string;
      if (context) {
        context.remote = remote.name;
      }
      try {
        const response = await forwardToRemote({
          remote,
          apiKey: await deps.getRemoteApiKey(remote.name),
          method: raw.method,
          path: url.pathname,
          search: url.search,
          headers: raw.headers,
          body: gemini ? geminiBody : body,
          upstreamModelId: entry.upstreamModelId,
          gemini,
          signal: raw.signal,
          requestId: reqId,
          fetchImpl: deps.fetchImpl,
        });
        if (response.status === 401 || response.status === 403) {
          deps.logger.warn(
            `[${reqId}] remote ${logId(remote.name)} rejected the gateway credentials (HTTP ${response.status}); set the key with 'Agent Gateway: Manage Remote Upstreams'`,
          );
        }
        return response;
      } catch (error) {
        if (error instanceof RemoteUnavailableError) {
          if (context) {
            context.errorKind = `remote_${error.category.replace(/\s+/g, "_")}`;
          }
          deps.logger.warn(
            `[${reqId}] Remote upstream ${logId(remote.name)} unavailable: ${error.category} (HTTP ${error.status}).`,
          );
          return errorResponse(protocol, error.status, error.message);
        }
        throw error;
      }
    }

    let target: string;
    let payload: () => string;
    let parsed: { value: unknown } | undefined;
    if (gemini) {
      target = `${url.origin}/v1beta/models/${encodeURIComponent(entry.upstreamModelId)}:${gemini.action}${url.search}`;
      const text = await c.req.text();
      payload = () => text;
      try {
        parsed = { value: JSON.parse(text) };
      } catch {
        // The handler reports the malformed body.
      }
    } else {
      target = `${url.origin}${url.pathname}${url.search}`;
      const forwarded = { ...body, model: entry.upstreamModelId };
      payload = () => JSON.stringify(forwarded);
      parsed = { value: forwarded };
    }
    const headers = new Headers(raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    // The body is serialised only if the handler reads it; the parsed value
    // travels with the request so it is not parsed twice.
    const request = new Request(target, {
      method: "POST",
      headers,
      body: lazyBody(payload),
      signal: raw.signal,
      duplex: "half",
    } as RequestInit);
    if (parsed) {
      attachParsedBody(request, parsed.value);
    }
    return deps.handleLocal(request);
  }

  app.onError((error, c) => {
    const context = currentRequestContext();
    if (context) {
      context.errorKind = "internal";
    }
    deps.logger.error(
      `[${c.get("requestId" as never) ?? "-"}] Unhandled gateway error (${error instanceof Error ? error.name : "unknown"}).`,
    );
    return errorResponse(
      protocolForPath(c.req.path),
      500,
      "Internal gateway error.",
    );
  });

  return app;
}
