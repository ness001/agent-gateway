import { countTokens } from "../core/countTokens";
import { GatewayError } from "../core/errors";
import type { LmApi } from "../core/lmRequest";
import { runTurn } from "../core/runTurn";
import type {
  CoreRequest,
  GatewayErrorInfo,
  LmChatLike,
  ProtocolDeps,
} from "../core/types";
import {
  CitationRegistry,
  createSearchHook,
  pagesToContext,
  runUrlContext,
  sourcesHook,
} from "../hosted";
import { BodyError, readJson } from "../http/body";
import { type CancellationSourceLike, RequestScope } from "../http/scope";
import { COMMENT_PING_FRAME, CollectSink, SseSink } from "../http/sink";
import { decodeGeminiRequest } from "./decode";
import { GeminiEncoder, geminiContentType } from "./encode";
import {
  geminiErrorResponse,
  geminiMalformedJson,
  geminiMethodNotAllowed,
  geminiModelNotFound,
  geminiUnsupportedRoute,
} from "./errors";
import { parseGeminiRoute } from "./route";

/** Host services; production reads them from `vscode`, tests inject fakes. */
export interface GeminiEnv {
  api: LmApi;
  createSource(): CancellationSourceLike;
  deadlineMs?: number;
}

let cachedEnv: GeminiEnv | undefined;

function vscodeEnv(): GeminiEnv {
  if (cachedEnv) {
    return cachedEnv;
  }
  const vs = require("vscode") as LmApi & {
    CancellationTokenSource: new () => CancellationSourceLike;
  };
  cachedEnv = { api: vs, createSource: () => new vs.CancellationTokenSource() };
  return cachedEnv;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Gemini handler: route, body, decode, then runTurn (generate) or
 * core countTokens. googleSearch / googleSearchRetrieval run the hosted
 * search loop; urlContext fetches pages before the model call.
 */
export async function handleGemini(
  request: Request,
  deps: ProtocolDeps,
  requestId: string,
  env: GeminiEnv = vscodeEnv(),
): Promise<Response> {
  const parsed = parseGeminiRoute(request.method, request.url);
  if (!parsed.ok) {
    if (parsed.reason === "method_not_allowed") {
      return geminiMethodNotAllowed(parsed.message, requestId);
    }
    if (parsed.reason === "invalid_model") {
      return geminiModelNotFound("", requestId, parsed.message);
    }
    return geminiUnsupportedRoute(parsed.message, requestId);
  }
  const route = parsed.route;
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (e) {
    if (e instanceof BodyError && e.reason === "MalformedJson") {
      return geminiMalformedJson(requestId);
    }
    return geminiErrorResponse(e as GatewayErrorInfo, requestId);
  }
  const model = deps.getLocalModel(route.model);
  if (!model) {
    return geminiModelNotFound(route.model, requestId);
  }
  const countOp = route.operation === "countTokens";
  let gen: unknown = body;
  if (countOp && isObj(body) && isObj(body.generateContentRequest)) {
    gen = body.generateContentRequest;
  }
  let req;
  try {
    req = decodeGeminiRequest(gen, {
      model: model.id,
      echoModel: route.model,
      stream: route.stream,
      logger: deps.logger,
      hostedSearch: deps.hosted?.search !== undefined,
    });
  } catch (e) {
    return geminiErrorResponse(asGatewayError(e), requestId);
  }
  if (countOp) {
    try {
      const totalTokens = await countTokens(env.api, model, req);
      return new Response(JSON.stringify({ totalTokens }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
      });
    } catch (e) {
      return geminiErrorResponse(asGatewayError(e), requestId);
    }
  }
  return generate(request, deps, requestId, env, model, req, route.framing);
}

function asGatewayError(e: unknown): GatewayErrorInfo {
  if (e && typeof e === "object" && "kind" in e) {
    return e as GatewayErrorInfo;
  }
  return new GatewayError("internal", (e as Error)?.message ?? String(e));
}

async function generate(
  request: Request,
  deps: ProtocolDeps,
  requestId: string,
  env: GeminiEnv,
  model: LmChatLike,
  decodedReq: CoreRequest,
  framing: "json" | "sse" | "array",
): Promise<Response> {
  let req = decodedReq;
  const scope = new RequestScope({
    requestId,
    protocol: "gemini",
    signal: request.signal,
    createSource: env.createSource,
    logger: deps.logger,
    deadlineMs: env.deadlineMs,
  });
  const encoder = new GeminiEncoder({
    mode: framing,
    modelVersion: req.echoModel,
    requestId,
    includeThoughts: req.echo.includeThoughts === true,
    maxOutputTokens: req.maxOutputTokens,
  });
  // urlContext fetches pages before the model call.
  let skipModel = false;
  let fetchedSources: CitationRegistry | undefined;
  if (req.hosted.some((h) => h.kind === "fetch")) {
    const abort = new AbortController();
    scope.onCancel(() => abort.abort());
    let ctx;
    try {
      ctx = await runUrlContext({
        turns: req.turns,
        engine: deps.hosted?.fetch,
        signal: abort.signal,
        logger: deps.logger,
        requestId,
      });
    } catch (e) {
      scope.dispose();
      if (abort.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return geminiErrorResponse(asGatewayError(e), requestId);
    }
    encoder.setUrlContext(ctx.urlMetadata);
    if (ctx.callModel) {
      fetchedSources = new CitationRegistry();
      fetchedSources.add(
        ctx.pages.map((p) => ({ url: p.url, title: p.title })),
      );
      req = {
        ...req,
        system: [
          ...req.system,
          `Content of the URLs in the user's message:

${pagesToContext(ctx.pages)}`,
        ],
      };
    } else {
      skipModel = true;
    }
  }
  const hook = createSearchHook({
    req,
    engines: deps.hosted,
    logger: deps.logger,
  });
  const common = {
    api: env.api,
    model,
    req,
    scope,
    encoder,
    logger: deps.logger,
    journal: deps,
    hosted: hook ?? (fetchedSources && sourcesHook(fetchedSources)),
  };
  if (skipModel) {
    // No page could be fetched: only ERROR/UNSAFE statuses, no model call.
    const sink = new CollectSink<string>();
    encoder.onEvent({ e: "end", reason: "stop" }, sink);
    encoder.finish(sink);
    scope.dispose();
    return new Response(sink.values().join(""), {
      status: 200,
      headers: {
        "content-type": geminiContentType(framing),
        "x-request-id": requestId,
      },
    });
  }
  if (framing === "json") {
    const sink = new CollectSink<string>();
    try {
      const r = await runTurn({ ...common, sink });
      if (r.outcome === "error" || encoder.error) {
        return geminiErrorResponse(
          (r.error ?? encoder.error) as GatewayErrorInfo,
          requestId,
        );
      }
      if (r.outcome === "cancelled") {
        return new Response(null, { status: 499 });
      }
      return new Response(sink.values().join(""), {
        status: 200,
        headers: {
          "content-type": geminiContentType("json"),
          "x-request-id": requestId,
        },
      });
    } finally {
      scope.dispose();
    }
  }
  const sink = new SseSink({
    heartbeatFrame: framing === "sse" ? COMMENT_PING_FRAME : undefined,
    onCancel: () => scope.cancel(),
  });
  void runTurn({ ...common, sink }).finally(() => {
    sink.close();
    scope.dispose();
  });
  return new Response(sink.stream, {
    status: 200,
    headers: {
      "content-type": geminiContentType(framing),
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}
