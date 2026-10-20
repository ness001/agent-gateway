import type { LocalRoutesDeps } from "../gateway/localRoutes";
import { handleAnthropic } from "./anthropic";
import {
  type ErrorProtocol,
  GatewayError,
  errorResponse,
  resolveRequestId,
} from "./core/errors";
import { randomToken } from "./core/ids";
import type { EffortInfo } from "./core/lmRequest";
import type { CoreLogger, ProtocolDeps, ProtocolId } from "./core/types";
import { handleGemini } from "./gemini";
import { handleChatCompletions } from "./openai/chat";
import { handleResponses } from "./openai/responses";

let discovery: { toModelInfo(m: unknown): EffortInfo } | undefined;

/** Model reasoning metadata from discovery; undefined when unreadable. */
function modelInfo(model: unknown): EffortInfo | undefined {
  discovery ??= require("../gateway/discovery") as {
    toModelInfo(m: unknown): EffortInfo;
  };
  try {
    return discovery.toModelInfo(model);
  } catch {
    return undefined;
  }
}

export interface Route {
  protocol: ProtocolId;
  /** Endpoint name, e.g. `messages`, `countTokens`, `generateContent`. */
  endpoint: string;
  model?: string;
}

const GEMINI_RE =
  /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

/** Path to route, independent of method. */
export function matchRoute(path: string): Route | undefined {
  switch (path) {
    case "/v1/messages":
      return { protocol: "anthropic", endpoint: "messages" };
    case "/v1/messages/count_tokens":
      return { protocol: "anthropic", endpoint: "countTokens" };
    case "/v1/chat/completions":
      return { protocol: "openai-chat", endpoint: "chatCompletions" };
    case "/v1/responses":
      return { protocol: "openai-responses", endpoint: "responses" };
  }
  const g = GEMINI_RE.exec(path);
  if (g) {
    let model = g[1];
    try {
      model = decodeURIComponent(model);
    } catch {
      // keep raw segment
    }
    return { protocol: "gemini", endpoint: g[2], model };
  }
  return undefined;
}

/** Error envelope family for an (unknown) path. */
export function envelopeFor(path: string): ErrorProtocol {
  if (path.startsWith("/v1beta/")) {
    return "google";
  }
  if (path.startsWith("/v1/messages")) {
    return "anthropic";
  }
  return "openai";
}

function familyOf(p: ProtocolId): ErrorProtocol {
  return p === "anthropic" ? "anthropic" : p === "gemini" ? "google" : "openai";
}

function withStatus(
  res: Response,
  status: number,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return new Response(res.body, { status, headers });
}

/** Per-protocol handler. */
export type RouteHandler = (
  req: Request,
  route: Route,
  deps: LocalRoutesDeps,
  requestId: string,
) => Promise<Response>;

const HANDLERS: Partial<Record<ProtocolId, RouteHandler>> = {
  // LocalRoutesDeps structurally carries the ProtocolDeps surface.
  gemini: (req, _route, deps, rid) =>
    handleGemini(req, deps as unknown as ProtocolDeps, rid),
  "openai-chat": (req, route, deps, rid) =>
    handleChatCompletions(req, route, deps as unknown as ProtocolDeps, rid),
  "openai-responses": (req, _route, deps, rid) => {
    const d = deps as unknown as ProtocolDeps;
    return handleResponses(
      req,
      {
        getLocalModel: (id) => d.getLocalModel(id),
        logger: d.logger,
        hosted: d.hosted,
        noteRequestError: d.noteRequestError,
        buildFor: (m) => {
          const info = modelInfo(m);
          return info ? { model: info } : {};
        },
      },
      rid,
    );
  },
  anthropic: (req, route, deps, rid) =>
    handleAnthropic(req, route, deps as unknown as ProtocolDeps, rid),
};

interface RequestContextModule {
  currentRequestContext(): { requestId: string } | undefined;
  noteRequestError(kind: string, providerCode?: string): void;
}
let requestContext: RequestContextModule | undefined;
let hostLogger: CoreLogger | undefined;

function gatewayRequestId(): string | undefined {
  try {
    requestContext ??=
      require("../gateway/requestContext") as RequestContextModule;
    return requestContext.currentRequestContext()?.requestId;
  } catch {
    return undefined;
  }
}

/**
 * Fills the output-channel logger and error journal from gateway/ when the
 * caller did not supply them (production); tests pass their own.
 */
function withHostServices(deps: LocalRoutesDeps): LocalRoutesDeps {
  const d = deps as unknown as Partial<ProtocolDeps>;
  if (d.logger && d.noteRequestError) {
    return deps;
  }
  let logger = d.logger;
  let note = d.noteRequestError;
  try {
    logger ??= hostLogger ??= (
      require("../utils/logger") as { logger: CoreLogger }
    ).logger;
    requestContext ??=
      require("../gateway/requestContext") as RequestContextModule;
    note ??= requestContext.noteRequestError;
  } catch {
    return deps;
  }
  return { ...deps, logger, noteRequestError: note } as LocalRoutesDeps;
}

/** Resolves the per-request hosted engines. */
async function withHosted(deps: LocalRoutesDeps): Promise<LocalRoutesDeps> {
  if (!deps.getHostedEngines) {
    return deps;
  }
  let hosted;
  try {
    hosted = await deps.getHostedEngines();
  } catch {
    hosted = undefined;
  }
  return { ...deps, hosted } as LocalRoutesDeps;
}

/** Protocol core entry point (lazy-required by localRoutes). */
export async function handle(
  request: Request,
  deps: LocalRoutesDeps,
): Promise<Response> {
  // Same id as the gateway's access log line and error journal when present.
  const requestId =
    gatewayRequestId() ??
    resolveRequestId(
      request.headers.get("x-request-id"),
      () => `req_${randomToken(24)}`,
    );
  const path = new URL(request.url).pathname;
  const route = matchRoute(path);
  if (!route) {
    return errorResponse(
      envelopeFor(path),
      new GatewayError("not_found", `Unknown endpoint: ${path}`),
      requestId,
    );
  }
  const family = familyOf(route.protocol);
  if (request.method !== "POST") {
    return withStatus(
      errorResponse(
        family,
        new GatewayError(
          "invalid_request",
          `Method ${request.method} is not allowed for ${path}; use POST.`,
        ),
        requestId,
      ),
      405,
      { allow: "POST" },
    );
  }
  const handler = HANDLERS[route.protocol];
  if (!handler) {
    return withStatus(
      errorResponse(
        family,
        new GatewayError(
          "unsupported",
          `The ${route.protocol} protocol core is not implemented yet.`,
        ),
        requestId,
      ),
      501,
    );
  }
  return handler(
    request,
    route,
    await withHosted(withHostServices(deps)),
    requestId,
  );
}
