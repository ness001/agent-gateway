import type {
  CoreEvent,
  CoreLogger,
  CoreRequest,
  HostedFetchTool,
  HostedSearchTool,
} from "../core/types";
import { CitationRegistry } from "./citations";
import {
  type ModelRound,
  internalFetchToolDef,
  internalSearchToolDef,
  internalToolNames,
  prepareHostedRequest,
  runSearchLoop,
} from "./searchLoop";
import type { HostedEngines } from "./types";

export * from "./citations";
export * from "./engines";
export {
  EngineError,
  ENGINE_TIMEOUT_MS,
  TRUNCATION_MARKER,
} from "./engines/engine";
export * from "./searchLoop";
export * from "./imageLinks";
export * from "./urlContext";
export * from "./urlSafety";
export * as anthropicOutput from "./output/anthropic";
export * as responsesOutput from "./output/responses";
export * as geminiOutput from "./output/gemini";

/**
 * Context runTurn passes to the hook. Superset of the current
 * `HostedContext` ({ req, scope }): adds `callModel` (one extra model round
 * with the same model, options and cancellation token) and an AbortSignal
 * tied to the request scope.
 */
export interface SearchHookContext {
  req: CoreRequest;
  scope: { readonly requestId: string };
  callModel: ModelRound;
  signal: AbortSignal;
}

/**
 * Hook runTurn calls (see report "Core changes needed"):
 *  1. `prepare(req)` before building the first LM request, so round 1
 *     already carries the internal search tool next to the client tools;
 *  2. `wrap(events, ctx)` on the first round's event stream.
 */
export interface SearchHook {
  prepare(req: CoreRequest): CoreRequest;
  wrap(
    events: AsyncIterable<CoreEvent>,
    ctx: SearchHookContext,
  ): AsyncIterable<CoreEvent>;
  /** Shared citation registry for encoders (stable indices). */
  readonly citations: CitationRegistry;
}

export function searchToolOf(req: CoreRequest): HostedSearchTool | undefined {
  return req.hosted.find((h): h is HostedSearchTool => h.kind === "search");
}

/** The fetch tool the model calls (Anthropic web_fetch), if any. */
export function fetchToolOf(req: CoreRequest): HostedFetchTool | undefined {
  return req.hosted.find(
    (h): h is HostedFetchTool => h.kind === "fetch" && h.asTool === true,
  );
}

/**
 * Creates the search hook for one request, or undefined when the request has
 * no hosted search tool or no engine is configured (the decoder's
 * no-provider policy then applies).
 */
export function createSearchHook(o: {
  req: CoreRequest;
  engines: HostedEngines | undefined;
  maxToolCalls?: number;
  logger?: CoreLogger;
}): SearchHook | undefined {
  if (!o.engines) {
    return undefined;
  }
  const engines = o.engines;
  const tool = engines.search ? searchToolOf(o.req) : undefined;
  const fetchTool = engines.fetch ? fetchToolOf(o.req) : undefined;
  if (!tool && !fetchTool) {
    return undefined;
  }
  const citations = new CitationRegistry();
  const { searchName, fetchName } = internalToolNames(o.req.tools);
  const allows = (maxUses: number | undefined) =>
    Math.min(engines.maxSearchesPerRequest, maxUses ?? 5) > 0;
  return {
    citations,
    prepare: (req) =>
      prepareHostedRequest(
        req,
        [
          ...(tool && allows(tool.maxUses)
            ? [internalSearchToolDef(searchName)]
            : []),
          ...(fetchTool && allows(fetchTool.maxUses)
            ? [internalFetchToolDef(fetchName)]
            : []),
        ],
        [searchName, fetchName],
        [
          ...(tool?.forced ? [searchName] : []),
          ...(fetchTool?.forced ? [fetchName] : []),
        ],
      ),
    wrap: (events, ctx) =>
      runSearchLoop({
        req: ctx.req,
        tool,
        engine: tool ? engines.search : undefined,
        fetchTool,
        fetchEngine: fetchTool ? engines.fetch : undefined,
        maxSearchesPerRequest: engines.maxSearchesPerRequest,
        maxToolCalls: o.maxToolCalls ?? ctx.req.maxToolCalls,
        callModel: ctx.callModel,
        firstRound: events,
        signal: ctx.signal,
        logger: o.logger,
        requestId: ctx.scope.requestId,
        citations,
      }),
  };
}
