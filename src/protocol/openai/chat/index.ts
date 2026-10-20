import { GatewayError } from "../../core/errors";
import type { BuildOptions, EffortInfo, LmApi } from "../../core/lmRequest";
import { type HostedHook, runTurn } from "../../core/runTurn";
import type {
  CoreLogger,
  GatewayErrorInfo,
  LmChatLike,
} from "../../core/types";
import { type FetchLike, resolveImageLinksInScope } from "../../hosted";
import { readJson } from "../../http/body";
import {
  type CancellationSourceLike,
  RequestScope,
  type RequestScope as RequestScopeT,
} from "../../http/scope";
import { CollectSink, SseSink } from "../../http/sink";
import { openAiErrorResponse, toErrorInfo } from "../errors";
import { chatEcho, decodeChatRequest } from "./decode";
import { ChatEncoder } from "./encode";

export { decodeChatRequest, chatEcho, NOT_OBJECT_MESSAGE } from "./decode";
export type { ChatEcho } from "./decode";
export { ChatEncoder, DONE_FRAME, chatUsage, finishReasonOf } from "./encode";
export type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionUsage,
  ChatEncoderOptions,
  ChatFinishReason,
} from "./encode";

/** Structural deps; `gateway/localRoutes.ts` LocalRoutesDeps satisfies this. */
export interface ChatDeps {
  getLocalModel(id: string): LmChatLike | undefined;
  logger?: CoreLogger;
  /** Fetch used to download image links (tests stub it). */
  fetchImage?: FetchLike;
  noteRequestError?(kind: string, providerCode?: string): void;
}

/** Test seams; production uses the `vscode` module lazily. */
export interface ChatRuntime {
  api: LmApi;
  createSource: () => CancellationSourceLike;
  build?: (model: LmChatLike) => BuildOptions;
  hosted?: HostedHook;
}

let cachedRuntime: ChatRuntime | undefined;

function vscodeRuntime(): ChatRuntime {
  // Lazy so tests and the bundle's cold path do not load `vscode` eagerly.
  if (cachedRuntime) {
    return cachedRuntime;
  }
  const vscode = require("vscode") as LmApi & {
    CancellationTokenSource: new () => CancellationSourceLike;
  };
  const discovery = require("../../../gateway/discovery") as {
    toModelInfo(m: unknown): EffortInfo;
  };
  cachedRuntime = {
    api: vscode,
    createSource: () => new vscode.CancellationTokenSource(),
    build: (model) => {
      try {
        return { model: discovery.toModelInfo(model) };
      } catch {
        return {};
      }
    },
  };
  return cachedRuntime;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

function journalOf(deps: ChatDeps) {
  return deps.noteRequestError
    ? { noteRequestError: deps.noteRequestError.bind(deps) }
    : { noteRequestError: defaultNote };
}

let requestContext:
  | { noteRequestError(kind: string, providerCode?: string): void }
  | undefined;

function defaultNote(kind: string, providerCode?: string): void {
  try {
    requestContext ??= require("../../../gateway/requestContext") as {
      noteRequestError(kind: string, providerCode?: string): void;
    };
    requestContext.noteRequestError(kind, providerCode);
  } catch {
    // no request context available (tests)
  }
}

function fail(
  deps: ChatDeps,
  e: GatewayErrorInfo,
  requestId: string,
): Response {
  journalOf(deps).noteRequestError(e.kind, e.providerCode);
  return openAiErrorResponse(e, requestId);
}

/**
 * POST /v1/chat/completions handler. Signature matches `RouteHandler` in
 * `protocol/index.ts` (the route argument is unused).
 */
export async function handleChatCompletions(
  request: Request,
  _route: unknown,
  deps: ChatDeps,
  requestId: string,
  runtime?: ChatRuntime,
): Promise<Response> {
  const logger = deps.logger;
  let decoded;
  try {
    decoded = decodeChatRequest(await readJson(request), logger);
  } catch (err) {
    return fail(deps, toErrorInfo(err), requestId);
  }
  const model = deps.getLocalModel(decoded.model);
  if (!model) {
    return fail(
      deps,
      new GatewayError(
        "not_found",
        `Model '${decoded.model}' is not available. See GET /v1/models.`,
        { param: "model" },
      ),
      requestId,
    );
  }
  const rt = runtime ?? vscodeRuntime();
  let req = { ...decoded, model: model.id };
  const scope: RequestScopeT = new RequestScope({
    requestId,
    protocol: "openai-chat",
    signal: request.signal,
    createSource: rt.createSource,
    logger,
  });
  req = await resolveImageLinksInScope(req, scope, {
    logger,
    fetch: deps.fetchImage,
  });
  const encoder = new ChatEncoder({
    model: req.echoModel,
    stream: req.stream,
    includeUsage: chatEcho(req).includeUsage,
    requestId,
  });
  const common = {
    api: rt.api,
    model,
    req,
    scope,
    encoder,
    logger,
    journal: journalOf(deps),
    ...(rt.build ? { build: rt.build(model) } : {}),
    ...(rt.hosted ? { hosted: rt.hosted } : {}),
  };

  if (!req.stream) {
    const sink = new CollectSink<string>();
    try {
      const result = await runTurn({ ...common, sink });
      if (result.outcome === "cancelled") {
        return new Response(null, { status: 499 });
      }
      const err = encoder.error ?? result.error;
      if (err) {
        return openAiErrorResponse(err, requestId);
      }
      return new Response(sink.values().join(""), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
      });
    } catch (err) {
      return fail(deps, toErrorInfo(err), requestId);
    } finally {
      scope.dispose();
    }
  }

  const sink = new SseSink({
    heartbeatFrame: ": ping\n\n",
    onCancel: () => scope.cancel(),
  });
  void (async () => {
    try {
      await runTurn({ ...common, sink });
    } catch (err) {
      // Pre-stream failures (e.g. image normalisation) still end the stream cleanly.
      const info = toErrorInfo(err);
      encoder.onEvent({ e: "error", err: info }, sink);
      journalOf(deps).noteRequestError(info.kind, info.providerCode);
    } finally {
      sink.close();
      scope.dispose();
    }
  })();
  return new Response(sink.stream, {
    status: 200,
    headers: { ...SSE_HEADERS, "x-request-id": requestId },
  });
}
