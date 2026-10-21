import { GatewayError, TIMEOUT_HINT } from "../core/errors";
import type { CoreLogger } from "../core/types";
import { type TimerApi, realTimers } from "./sink";

export const DEADLINE_MS = 600_000;
export const FIRST_CHUNK_WARN_MS = 20_000;

/** Structural subset of vscode.CancellationTokenSource. */
export interface CancellationSourceLike {
  readonly token: { readonly isCancellationRequested: boolean };
  cancel(): void;
  dispose(): void;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", fn: () => void): void;
  removeEventListener(type: "abort", fn: () => void): void;
}

export interface RequestScopeOptions {
  /** Usually currentRequestContext()?.requestId from gateway/requestContext. */
  requestId: string;
  protocol: string;
  signal?: AbortSignalLike;
  createSource: () => CancellationSourceLike;
  logger?: Pick<CoreLogger, "warn"> & Partial<Pick<CoreLogger, "info">>;
  timers?: TimerApi;
  deadlineMs?: number;
  firstChunkWarnMs?: number;
}

export type CancelReason = "client_abort" | "timeout";

/** Per-request lifetime: one cancellation source, deadline, first-chunk warning. */
export class RequestScope {
  readonly requestId: string;
  readonly source: CancellationSourceLike;
  private reasonValue: CancelReason | undefined;
  private deadline: unknown;
  private firstChunk: unknown;
  private disposed = false;
  private readonly timers: TimerApi;
  private readonly listeners: Array<(r: CancelReason) => void> = [];
  private readonly onAbort = (): void => this.cancelWith("client_abort");

  constructor(private readonly opts: RequestScopeOptions) {
    this.requestId = opts.requestId;
    this.timers = opts.timers ?? realTimers;
    this.source = opts.createSource();
    const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
    const warnMs = opts.firstChunkWarnMs ?? FIRST_CHUNK_WARN_MS;
    this.deadline = this.timers.setTimeout(
      () => this.cancelWith("timeout"),
      deadlineMs,
    );
    this.firstChunk = this.timers.setTimeout(() => {
      this.firstChunk = undefined;
      opts.logger?.warn(
        `[${this.requestId}] ${opts.protocol} no first chunk after ${Math.round(warnMs / 1000)} s. Request is still pending (deadline: ${Math.round(deadlineMs / 1000)} s). Prompt processing, model reasoning, or service load can delay output. If VS Code shows a model-access prompt, approve it to continue.`,
      );
    }, warnMs);
    if (opts.signal?.aborted) {
      this.cancelWith("client_abort");
    } else {
      opts.signal?.addEventListener("abort", this.onAbort);
    }
  }

  get token(): { readonly isCancellationRequested: boolean } {
    return this.source.token;
  }

  get reason(): CancelReason | undefined {
    return this.reasonValue;
  }

  onCancel(fn: (r: CancelReason) => void): void {
    this.listeners.push(fn);
  }

  /** The client went away (e.g. the SSE stream was cancelled); cancels upstream. */
  cancel(): void {
    this.cancelWith("client_abort");
  }

  /** Call when the first model chunk arrives; suppresses the warning. */
  markFirstChunk(): void {
    this.clear("firstChunk");
  }

  /** A `timeout` GatewayError (504) when the deadline fired, else undefined. */
  timeoutError(): GatewayError | undefined {
    if (this.reasonValue !== "timeout") {
      return undefined;
    }
    const secs = Math.round((this.opts.deadlineMs ?? DEADLINE_MS) / 1000);
    return new GatewayError(
      "timeout",
      `Request exceeded ${secs} s. ${TIMEOUT_HINT}`,
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear("deadline");
    this.clear("firstChunk");
    this.opts.signal?.removeEventListener("abort", this.onAbort);
    this.source.dispose();
  }

  private cancelWith(reason: CancelReason): void {
    if (this.reasonValue || this.disposed) {
      return;
    }
    this.reasonValue = reason;
    if (reason === "client_abort") {
      this.opts.logger?.info?.(
        `[${this.requestId}] ${this.opts.protocol} client disconnected; cancelling the model request`,
      );
    }
    this.clear("deadline");
    this.clear("firstChunk");
    this.source.cancel();
    for (const l of this.listeners) {
      try {
        l(reason);
      } catch {
        // listeners must not break cancellation
      }
    }
  }

  private clear(which: "deadline" | "firstChunk"): void {
    const h = this[which];
    if (h !== undefined) {
      this.timers.clearTimeout(h);
      this[which] = undefined;
    }
  }
}
