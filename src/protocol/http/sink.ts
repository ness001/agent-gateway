/** Silence before a heartbeat frame is written. */
export const HEARTBEAT_MS = 15_000;
export const ANTHROPIC_PING_FRAME = 'event: ping\ndata: {"type": "ping"}\n\n';
export const COMMENT_PING_FRAME = ": ping\n\n";

/** Minimal timer surface so tests can inject fakes. */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SseSinkOptions {
  /** Frame written after `heartbeatMs` of silence; omit to disable. */
  heartbeatFrame?: string;
  heartbeatMs?: number;
  timers?: TimerApi;
  /** Called once when the consumer cancels before the sink closed. */
  onCancel?: () => void;
}

/**
 * Pull-based SSE sink. Frames are complete strings, encoded once and queued.
 * After cancel or close, further writes are dropped, so no success terminal
 * can follow a cancel.
 */
export class SseSink {
  readonly stream: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly queue: Uint8Array[] = [];
  private waiting: (() => void) | undefined;
  private done = false;
  private cancelledFlag = false;
  private heartbeat: unknown;
  private readonly timers: TimerApi;

  constructor(private readonly opts: SseSinkOptions = {}) {
    this.timers = opts.timers ?? realTimers;
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: (c) => this.pull(c),
        cancel: () => this.cancel(),
      },
      { highWaterMark: 0 },
    );
    this.armHeartbeat();
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get closed(): boolean {
    return this.done;
  }

  /** Queues one frame. Returns false when the frame was dropped. */
  write(frame: string): boolean {
    if (this.done) {
      return false;
    }
    this.queue.push(this.encoder.encode(frame));
    this.wake();
    this.armHeartbeat();
    return true;
  }

  /** Ends the stream after pending frames are read. */
  close(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.stopHeartbeat();
    this.wake();
  }

  /** Client disconnect: drop queued and later frames. */
  cancel(): void {
    if (this.cancelledFlag) {
      return;
    }
    const wasDone = this.done;
    this.cancelledFlag = true;
    this.done = true;
    this.queue.length = 0;
    this.stopHeartbeat();
    this.wake();
    if (!wasDone) {
      this.opts.onCancel?.();
    }
  }

  private async pull(
    c: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    while (this.queue.length === 0 && !this.done) {
      await new Promise<void>((r) => (this.waiting = r));
    }
    if (this.queue.length > 0 && !this.cancelledFlag) {
      // Everything queued so far goes out as one chunk (one socket write).
      c.enqueue(this.queue.length === 1 ? this.queue[0] : concat(this.queue));
      this.queue.length = 0;
      return;
    }
    try {
      c.close();
    } catch {
      // stream already cancelled
    }
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = undefined;
    w?.();
  }

  private armHeartbeat(): void {
    const frame = this.opts.heartbeatFrame;
    if (!frame || this.done) {
      return;
    }
    this.stopHeartbeat();
    this.heartbeat = this.timers.setTimeout(() => {
      this.heartbeat = undefined;
      this.write(frame);
    }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      this.timers.clearTimeout(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Aggregates values for a non-streaming JSON response. */
export class CollectSink<T> {
  private readonly items: T[] = [];
  private cancelledFlag = false;

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  write(item: T): boolean {
    if (this.cancelledFlag) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  cancel(): void {
    this.cancelledFlag = true;
  }

  values(): readonly T[] {
    return this.items;
  }
}
