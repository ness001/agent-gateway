import { countTokens } from "../core/countTokens";
import { GatewayError } from "../core/errors";
import type { BuildOptions, EffortInfo, LmApi } from "../core/lmRequest";
import { type TurnSink, runTurn } from "../core/runTurn";
import type { CoreLogger, LmChatLike } from "../core/types";
import {
  type FetchLike,
  createSearchHook,
  resolveImageLinksInScope,
} from "../hosted";
import type { HostedEngines } from "../hosted/types";
import { readJson } from "../http/body";
import {
  type AbortSignalLike,
  type CancellationSourceLike,
  RequestScope,
} from "../http/scope";
import { ANTHROPIC_PING_FRAME, SseSink, type TimerApi } from "../http/sink";
import { decodeMessagesRequest } from "./decode";
import { AnthropicEncoder, collectMessage, sseFrame } from "./encode";
import { anthropicError, toErrorInfo } from "./errors";
import type { WireStreamEvent } from "./wire";

export { decodeMessagesRequest, MISSING_MODEL_MESSAGE } from "./decode";
export { AnthropicEncoder, collectMessage, sseFrame } from "./encode";
export { anthropicError } from "./errors";

/** Structural route info (matches `Route` in protocol/index.ts). */
export interface AnthropicRoute {
  endpoint: string;
}

/** Structural subset of LocalRoutesDeps used by this adapter. */
export interface AnthropicDeps {
  getLocalModel(id: string): unknown;
  /** Hosted search/fetch engines; undefined when the provider is `none`. */
  hosted?: HostedEngines;
  /** Fetch used to download image links (tests stub it). */
  fetchImage?: FetchLike;
}

/** Injection points; production values come from `vscode` and gateway/. */
export interface AnthropicRuntime {
  api: LmApi;
  createSource: () => CancellationSourceLike;
  modelInfo?: (model: LmChatLike) => EffortInfo | undefined;
  logger?: CoreLogger;
  journal?: { noteRequestError?(kind: string, providerCode?: string): void };
  timers?: TimerApi;
  heartbeatMs?: number;
}

let cachedRuntime: AnthropicRuntime | undefined;

/** Lazily builds the production runtime (keeps `vscode` out of module load). */
function defaultRuntime(): AnthropicRuntime {
  if (cachedRuntime) {
    return cachedRuntime;
  }
  const vscode = require("vscode") as Record<string, unknown> & {
    CancellationTokenSource: new () => CancellationSourceLike;
  };
  const discovery = require("../../gateway/discovery") as {
    toModelInfo(m: unknown): EffortInfo;
  };
  const ctx = require("../../gateway/requestContext") as {
    noteRequestError(kind: string, providerCode?: string): void;
  };
  const log = require("../../utils/logger") as { logger: CoreLogger };
  cachedRuntime = {
    api: vscode as unknown as LmApi,
    createSource: () => new vscode.CancellationTokenSource(),
    modelInfo: (m) => {
      try {
        return discovery.toModelInfo(m);
      } catch {
        return undefined;
      }
    },
    logger: log.logger,
    journal: { noteRequestError: ctx.noteRequestError },
  };
  return cachedRuntime;
}

function sseHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": requestId,
  };
}

function lookupModel(deps: AnthropicDeps, id: string): LmChatLike {
  const m = deps.getLocalModel(id) as LmChatLike | undefined;
  if (!m) {
    throw new GatewayError(
      "not_found",
      `Model '${id}' is not available. See GET /v1/models.`,
    );
  }
  return m;
}

/**
 * Anthropic Messages handler for `/v1/messages` and
 * `/v1/messages/count_tokens` (signature matches `RouteHandler`).
 * A `?beta=true` query is tolerated (ignored).
 */
export async function handleAnthropic(
  request: Request,
  route: AnthropicRoute,
  deps: AnthropicDeps,
  requestId: string,
  runtime: AnthropicRuntime = defaultRuntime(),
): Promise<Response> {
  const isCount = route.endpoint === "countTokens";
  let scope: RequestScope | undefined;
  try {
    const body = await readJson(request);
    let req = decodeMessagesRequest(body, {
      countTokens: isCount,
      hostedSearch: deps.hosted?.search !== undefined,
      hostedFetch: deps.hosted?.fetch !== undefined,
      logger: runtime.logger,
    });
    const model = lookupModel(deps, req.model);
    req.model = model.id;

    scope = new RequestScope({
      requestId,
      protocol: "anthropic",
      signal: request.signal as AbortSignalLike | undefined,
      createSource: runtime.createSource,
      logger: runtime.logger,
      timers: runtime.timers,
    });

    if (isCount) {
      const n = await countTokens(runtime.api, model, req, scope.token);
      scope.dispose();
      return new Response(JSON.stringify({ input_tokens: n }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
      });
    }

    req = await resolveImageLinksInScope(req, scope, {
      logger: runtime.logger,
      fetch: deps.fetchImage,
    });
    const build: BuildOptions = {};
    const info = runtime.modelInfo?.(model);
    if (info) {
      build.model = info;
    }
    const hook = createSearchHook({
      req,
      engines: deps.hosted,
      logger: runtime.logger,
    });
    const encoder = new AnthropicEncoder({
      echoModel: req.echoModel,
      requestId,
      citations: hook?.citations,
    });

    if (req.stream) {
      const s = scope;
      const sse = new SseSink({
        heartbeatFrame: ANTHROPIC_PING_FRAME,
        heartbeatMs: runtime.heartbeatMs,
        timers: runtime.timers,
        onCancel: () => s.cancel(),
      });
      const sink: TurnSink<WireStreamEvent> = {
        write: (ev) => sse.write(sseFrame(ev)),
        get cancelled() {
          return sse.cancelled;
        },
      };
      void runTurn({
        api: runtime.api,
        model,
        req,
        scope: s,
        encoder,
        sink,
        logger: runtime.logger,
        journal: runtime.journal,
        build,
        hosted: hook,
      })
        .catch((err: unknown) => {
          encoder.onEvent({ e: "error", err: toErrorInfo(err) }, sink);
        })
        .finally(() => {
          sse.close();
          s.dispose();
        });
      return new Response(sse.stream, {
        status: 200,
        headers: sseHeaders(requestId),
      });
    }

    const events: WireStreamEvent[] = [];
    const sink: TurnSink<WireStreamEvent> = {
      write: (ev) => {
        events.push(ev);
        return true;
      },
      cancelled: false,
    };
    const result = await runTurn({
      api: runtime.api,
      model,
      req,
      scope,
      encoder,
      sink,
      logger: runtime.logger,
      journal: runtime.journal,
      build,
      hosted: hook,
    });
    scope.dispose();
    if (result.outcome === "error" && result.error) {
      return anthropicError(result.error, requestId);
    }
    const c = collectMessage(events, { id: encoder.id, model: req.echoModel });
    if (!c.ok) {
      return anthropicError(
        new GatewayError("internal", c.error.error.message),
        requestId,
      );
    }
    return new Response(JSON.stringify(c.message), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    });
  } catch (err) {
    scope?.dispose();
    const info = toErrorInfo(err);
    runtime.journal?.noteRequestError?.(info.kind, info.providerCode);
    return anthropicError(info, requestId);
  }
}
