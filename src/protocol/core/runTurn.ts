import { type ErrorJournal, classifyLmError, noteRequestError } from "./errors";
import { type BuildOptions, type LmApi, buildLmRequest } from "./lmRequest";
import { lmStreamToEvents } from "./lmStream";
import { logRepairs, repairPairing } from "./pairing";
import { logRequestSettings, settingsFromRequest } from "./settingsLog";
import { recoverRejectedToolHistory } from "./toolRecovery";
import type {
  CoreEvent,
  CoreLogger,
  CoreRequest,
  GatewayErrorInfo,
  LmChatLike,
  NormalizedUsage,
} from "./types";

/** Minimal sink contract shared by SseSink and CollectSink. */
export interface TurnSink<F = unknown> {
  write(frame: F): boolean;
  readonly cancelled: boolean;
}

/** One encoder per protocol, used for both SSE and JSON aggregation. */
export interface Encoder<F = unknown> {
  onEvent(ev: CoreEvent, sink: TurnSink<F>): void;
  finish(sink: TurnSink<F>): void;
}

/** Structural subset of `http/scope.ts` RequestScope used here. */
export interface TurnScope {
  readonly requestId: string;
  readonly token: { readonly isCancellationRequested: boolean };
  readonly reason: "client_abort" | "timeout" | undefined;
  markFirstChunk(): void;
  timeoutError(): GatewayErrorInfo | undefined;
  /** Optional cancellation listener (RequestScope provides it). */
  onCancel?(fn: (reason: "client_abort" | "timeout") => void): void;
}

export interface HostedContext {
  req: CoreRequest;
  scope: TurnScope;
  /** One extra model round with the same model, options and token. */
  callModel(req: CoreRequest): AsyncIterable<CoreEvent>;
  /** Aborted when the scope cancels (client abort or timeout). */
  signal: AbortSignal;
}

/** Hosted tool loop hook (search/fetch). */
export interface HostedHook {
  /** Called before the first LM request so round 1 offers hosted tools. */
  prepare?(req: CoreRequest): CoreRequest;
  wrap(
    events: AsyncIterable<CoreEvent>,
    ctx: HostedContext,
  ): AsyncIterable<CoreEvent>;
}

export const noopHostedHook: HostedHook = { wrap: (events) => events };

export interface RunTurnOptions<F = unknown> {
  api: LmApi;
  model: LmChatLike;
  req: CoreRequest;
  scope: TurnScope;
  encoder: Encoder<F>;
  sink: TurnSink<F>;
  logger?: CoreLogger;
  journal?: ErrorJournal;
  build?: BuildOptions;
  hosted?: HostedHook;
}

export type TurnOutcome = "completed" | "cancelled" | "error";

export interface TurnResult {
  outcome: TurnOutcome;
  usage?: NormalizedUsage;
  error?: GatewayErrorInfo;
}

/**
 * Runs one model turn: pairing repair, LM request, event stream to the
 * encoder. A client abort ends silently (no terminal); a timeout or LM
 * failure becomes one `error` event followed by `finish`.
 */
export async function runTurn<F>(o: RunTurnOptions<F>): Promise<TurnResult> {
  const { scope, encoder, sink } = o;
  const aborted = (): boolean =>
    scope.reason === "client_abort" || sink.cancelled;
  const fail = (err: GatewayErrorInfo): TurnResult => {
    noteRequestError(o.journal, err);
    if (!aborted()) {
      encoder.onEvent({ e: "error", err }, sink);
      encoder.finish(sink);
    }
    return { outcome: "error", error: err };
  };

  const hook = o.hosted ?? noopHostedHook;
  const prepared = hook.prepare ? hook.prepare(o.req) : o.req;
  const { turns, repairs } = repairPairing(prepared.turns);
  if (repairs.length && o.logger) {
    logRepairs(repairs, o.logger, scope.requestId, o.req.protocol);
  }
  logRequestSettings(
    o.logger,
    {
      requestId: scope.requestId,
      protocol: o.req.protocol,
      requestedModel: o.req.echoModel,
      resolvedModel: o.model.id,
    },
    settingsFromRequest(o.req),
  );

  const abort = new AbortController();
  if (scope.reason) {
    abort.abort();
  }
  scope.onCancel?.(() => abort.abort());
  const callModel = (req: CoreRequest): AsyncIterable<CoreEvent> =>
    roundEvents(o, req, scope);

  let usage: NormalizedUsage | undefined;
  let first = true;
  const markActivity = (): void => {
    if (first) {
      first = false;
      scope.markFirstChunk();
    }
  };
  try {
    const events = hook.wrap(
      requestEvents(o, { ...prepared, turns }, scope, markActivity),
      {
        req: o.req,
        scope,
        callModel,
        signal: abort.signal,
      },
    );
    for await (const ev of events) {
      if (scope.reason || sink.cancelled) {
        abort.abort();
        break;
      }
      markActivity();
      if (ev.e === "end") {
        usage = ev.usage;
      }
      encoder.onEvent(ev, sink);
      if (ev.e === "error") {
        noteRequestError(o.journal, ev.err);
      }
    }
  } catch (err) {
    if (aborted()) {
      return { outcome: "cancelled" };
    }
    return fail(scope.timeoutError() ?? classifyLmError(err));
  }
  if (aborted()) {
    return { outcome: "cancelled" };
  }
  const t = scope.timeoutError();
  if (t) {
    return fail(t);
  }
  encoder.finish(sink);
  return usage ? { outcome: "completed", usage } : { outcome: "completed" };
}

/** One additional model round for the hosted loop (pairing repair included). */
async function* roundEvents<F>(
  o: RunTurnOptions<F>,
  req: CoreRequest,
  scope: TurnScope,
): AsyncIterable<CoreEvent> {
  const { turns } = repairPairing(req.turns);
  yield* requestEvents(o, { ...req, turns }, scope);
}

/** Retry only a pre-output missing-call rejection, once per model round. */
async function* requestEvents<F>(
  o: RunTurnOptions<F>,
  req: CoreRequest,
  scope: TurnScope,
  onActivity?: () => void,
): AsyncIterable<CoreEvent> {
  let current = req;
  for (let attempt = 0; attempt < 2; attempt++) {
    let started = false;
    try {
      const lm = buildLmRequest(o.api, current, o.build);
      // VS Code merges this over the provider's saved/default configuration.
      // Without it Copilot can trim to its smaller default despite advertising
      // a larger maxInputTokens, splitting historical tool call/result pairs.
      // Use the resolved model's input budget, never the requested output limit.
      if (
        o.model.vendor === "copilot" &&
        Number.isSafeInteger(o.model.maxInputTokens) &&
        o.model.maxInputTokens > 0
      ) {
        lm.options.configuration = { contextSize: o.model.maxInputTokens };
      }
      const response = await o.model.sendRequest(
        lm.messages,
        lm.options,
        scope.token,
      );
      async function* tracked(): AsyncIterable<unknown> {
        for await (const part of response.stream) {
          // Even an ignored/usage part means the provider has started work.
          if (!started) {
            onActivity?.();
          }
          started = true;
          yield part;
        }
      }
      yield* lmStreamToEvents(tracked(), {
        maxOutputTokens: current.maxOutputTokens,
      });
      return;
    } catch (error) {
      if (
        attempt !== 0 ||
        started ||
        scope.reason ||
        scope.token.isCancellationRequested ||
        o.sink.cancelled
      ) {
        throw error;
      }
      const turns = recoverRejectedToolHistory(current.turns, error);
      if (!turns) {
        throw error;
      }
      o.logger?.warn(
        "Retrying rejected tool history once as historical text; tool contents preserved.",
      );
      current = { ...current, turns };
    }
  }
}
