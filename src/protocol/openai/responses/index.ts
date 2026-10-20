import { GatewayError } from "../../core/errors";
import type { BuildOptions, LmApi } from "../../core/lmRequest";
import { runTurn } from "../../core/runTurn";
import type { CoreLogger, LmChatLike } from "../../core/types";
import {
  type FetchLike,
  createSearchHook,
  resolveImageLinksInScope,
} from "../../hosted";
import type { HostedEngines } from "../../hosted/types";
import { BodyError, readJson } from "../../http/body";
import {
  type AbortSignalLike,
  type CancellationSourceLike,
  RequestScope,
} from "../../http/scope";
import { COMMENT_PING_FRAME, CollectSink, SseSink } from "../../http/sink";
import { decodeResponses } from "./decode";
import { ResponsesEncoder, type ResponsesFrame, formatFrame } from "./encode";
import { responsesErrorResponse } from "./errors";

export { decodeResponses } from "./decode";
export type { ResponsesDecoded } from "./decode";
export {
  ResponsesEncoder,
  formatFrame,
  toWireUsage,
  type ResponseObject,
  type ResponsesFrame,
} from "./encode";
export { responsesErrorResponse, toResponsesError } from "./errors";

/** Dependencies of the Responses handler (structural, testable). */
export interface ResponsesDeps {
  getLocalModel(id: string): LmChatLike | undefined;
  logger?: CoreLogger;
  /** Fetch used to download image links (tests stub it). */
  fetchImage?: FetchLike;
  /** Hosted search engines; undefined when the provider is `none`. */
  hosted?: HostedEngines;
  noteRequestError?(kind: string, providerCode?: string): void;
  /** Defaults to the `vscode` module (required lazily). */
  api?: LmApi;
  /** Defaults to `new vscode.CancellationTokenSource()`. */
  createSource?: () => CancellationSourceLike;
  build?: BuildOptions;
  /** Per-model build options (e.g. reasoning levels); wins over `build`. */
  buildFor?: (model: LmChatLike) => BuildOptions;
}

type VscodeModule = LmApi & {
  CancellationTokenSource: new () => CancellationSourceLike;
};
let vscodeCached: VscodeModule | undefined;

function vscodeModule(): VscodeModule {
  return (vscodeCached ??= require("vscode") as VscodeModule);
}

function toGatewayError(e: unknown): GatewayError | undefined {
  if (e instanceof GatewayError) {
    return e;
  }
  if (e instanceof BodyError) {
    return new GatewayError("invalid_request", e.message);
  }
  return undefined;
}

/** POST /v1/responses handler (register in protocol/index.ts after merge). */
export async function handleResponses(
  request: Request,
  deps: ResponsesDeps,
  requestId: string,
): Promise<Response> {
  let decoded;
  try {
    decoded = decodeResponses(await readJson(request), {
      logger: deps.logger,
      hostedSearch: deps.hosted?.search !== undefined,
    });
  } catch (e) {
    const g = toGatewayError(e);
    if (g) {
      return responsesErrorResponse(g, requestId);
    }
    throw e;
  }
  let { core } = decoded;
  const model = deps.getLocalModel(core.model);
  if (!model) {
    return responsesErrorResponse(
      new GatewayError(
        "not_found",
        `The model '${core.model}' does not exist.`,
        {
          param: "model",
          providerCode: "model_not_found",
        },
      ),
      requestId,
    );
  }
  const api = deps.api ?? vscodeModule();
  const createSource =
    deps.createSource ?? (() => new (vscodeModule().CancellationTokenSource)());
  const scope = new RequestScope({
    requestId,
    protocol: "openai-responses",
    signal: request.signal as AbortSignalLike | undefined,
    createSource,
    logger: deps.logger,
  });
  core = await resolveImageLinksInScope(core, scope, {
    logger: deps.logger,
    fetch: deps.fetchImage,
  });
  const hook = createSearchHook({
    req: core,
    engines: deps.hosted,
    maxToolCalls: core.maxToolCalls,
    logger: deps.logger,
  });
  const encoder = new ResponsesEncoder(core, {
    includeEncryptedReasoning: decoded.includeEncryptedReasoning,
    summary: decoded.reasoningSummary !== null,
    namespaced: decoded.namespaced,
    custom: decoded.custom,
    toolSearch: decoded.toolSearch,
    citations: hook?.citations,
  });
  const journal = { noteRequestError: deps.noteRequestError };
  const headers = { "x-request-id": requestId };

  if (core.stream) {
    const sse = new SseSink({
      heartbeatFrame: COMMENT_PING_FRAME,
      onCancel: () => scope.cancel(),
    });
    const sink = {
      write: (f: ResponsesFrame) => sse.write(formatFrame(f)),
      get cancelled() {
        return sse.cancelled;
      },
    };
    void runTurn({
      api,
      model,
      req: core,
      scope,
      encoder,
      sink,
      logger: deps.logger,
      journal,
      build: deps.buildFor?.(model) ?? deps.build,
      hosted: hook,
    })
      .catch((e: unknown) => {
        deps.logger?.error(
          `[${requestId}] openai-responses stream failed: ${e instanceof Error ? e.name : "unknown"}`,
        );
      })
      .finally(() => {
        sse.close();
        scope.dispose();
      });
    return new Response(sse.stream, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  const sink = new CollectSink<ResponsesFrame>();
  try {
    const result = await runTurn({
      api,
      model,
      req: core,
      scope,
      encoder,
      sink,
      logger: deps.logger,
      journal,
      build: deps.buildFor?.(model) ?? deps.build,
      hosted: hook,
    });
    if (result.outcome === "error" && result.error) {
      return responsesErrorResponse(result.error, requestId);
    }
    if (result.outcome === "cancelled") {
      return new Response(null, { status: 499, headers });
    }
    return new Response(JSON.stringify(encoder.result()), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  } finally {
    scope.dispose();
  }
}
