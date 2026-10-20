import * as assert from "assert";

import { ERROR_TABLE } from "../../../protocol/core/errors";
import {
  type CancellationSourceLike,
  RequestScope,
} from "../../../protocol/http/scope";
import {
  ANTHROPIC_PING_FRAME,
  COMMENT_PING_FRAME,
  CollectSink,
  SseSink,
  type TimerApi,
} from "../../../protocol/http/sink";

class FakeTimers implements TimerApi {
  now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.pending.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.pending) {
        if (e[1].at <= end && (!next || e[1].at < next[1].at)) {
          next = e;
        }
      }
      if (!next) {
        break;
      }
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

class FakeSource implements CancellationSourceLike {
  token = { isCancellationRequested: false };
  disposed = 0;
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {
    this.disposed++;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return out;
    }
    out += dec.decode(value);
  }
}

function makeScope(t: FakeTimers, signal?: AbortSignal) {
  const warns: string[] = [];
  const infos: string[] = [];
  const src = new FakeSource();
  const scope = new RequestScope({
    requestId: "rid-1",
    protocol: "anthropic",
    signal,
    createSource: () => src,
    logger: { warn: (m) => warns.push(m), info: (m) => infos.push(m) },
    timers: t,
  });
  return { scope, src, warns, infos };
}

suite("protocol/http sink and scope", () => {
  test("first-chunk warning logged once at 20 s with consent hint", () => {
    const t = new FakeTimers();
    const { scope, warns } = makeScope(t);
    t.advance(19_999);
    assert.strictEqual(warns.length, 0);
    t.advance(1);
    t.advance(60_000);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /^\[rid-1\] anthropic no first chunk after 20 s/);
    scope.dispose();
  });

  test("no warning when first chunk arrives in time", () => {
    const t = new FakeTimers();
    const { scope, warns } = makeScope(t);
    t.advance(5_000);
    scope.markFirstChunk();
    t.advance(30_000);
    assert.strictEqual(warns.length, 0);
    scope.dispose();
  });

  test("600 s deadline cancels and yields timeout 504", () => {
    const t = new FakeTimers();
    const { scope, src } = makeScope(t);
    const reasons: string[] = [];
    scope.onCancel((r) => reasons.push(r));
    t.advance(599_999);
    assert.strictEqual(scope.timeoutError(), undefined);
    t.advance(1);
    assert.strictEqual(src.token.isCancellationRequested, true);
    assert.deepStrictEqual(reasons, ["timeout"]);
    const err = scope.timeoutError();
    assert.strictEqual(err?.kind, "timeout");
    assert.strictEqual(ERROR_TABLE.timeout.status, 504);
    scope.dispose();
  });

  test("client abort cancels the token source", () => {
    const t = new FakeTimers();
    const ac = new AbortController();
    const { scope, src, infos } = makeScope(t, ac.signal);
    ac.abort();
    assert.strictEqual(src.token.isCancellationRequested, true);
    assert.strictEqual(scope.reason, "client_abort");
    assert.deepStrictEqual(infos, [
      "[rid-1] anthropic client disconnected; cancelling the model request",
    ]);
    assert.strictEqual(scope.timeoutError(), undefined);
    scope.dispose();
  });

  test("a cancelled stream cancels upstream and logs once", () => {
    const { scope, src, infos } = makeScope(new FakeTimers());
    scope.cancel();
    scope.cancel();
    assert.strictEqual(src.token.isCancellationRequested, true);
    assert.strictEqual(infos.length, 1);
    scope.dispose();
  });

  test("already-aborted signal cancels immediately", () => {
    const ac = new AbortController();
    ac.abort();
    const { src } = makeScope(new FakeTimers(), ac.signal);
    assert.strictEqual(src.token.isCancellationRequested, true);
  });

  test("no writes and no success terminal after cancel", async () => {
    let cancels = 0;
    const sink = new SseSink({ onCancel: () => cancels++ });
    const reader = sink.stream.getReader();
    sink.write("data: a\n\n");
    const first = await reader.read();
    assert.strictEqual(new TextDecoder().decode(first.value), "data: a\n\n");
    await reader.cancel();
    assert.strictEqual(sink.cancelled, true);
    assert.strictEqual(sink.write("event: message_stop\n\n"), false);
    sink.close();
    assert.strictEqual(cancels, 1);
  });

  test("frames flushed then stream ends on close", async () => {
    const sink = new SseSink();
    sink.write("data: 1\n\n");
    sink.write("data: 2\n\n");
    sink.close();
    assert.strictEqual(sink.write("data: 3\n\n"), false);
    assert.strictEqual(await readAll(sink.stream), "data: 1\n\ndata: 2\n\n");
  });

  test("frames queued together are read as one chunk", async () => {
    const sink = new SseSink();
    const reader = sink.stream.getReader();
    sink.write("data: 1\n\n");
    sink.write("data: 2\n\n");
    const first = await reader.read();
    assert.strictEqual(
      new TextDecoder().decode(first.value),
      "data: 1\n\ndata: 2\n\n",
    );
    sink.close();
    assert.strictEqual((await reader.read()).done, true);
  });

  test("heartbeat after 15 s silence, reset by writes", async () => {
    const t = new FakeTimers();
    const sink = new SseSink({
      heartbeatFrame: ANTHROPIC_PING_FRAME,
      timers: t,
    });
    t.advance(10_000);
    sink.write("data: x\n\n");
    t.advance(14_999);
    t.advance(1);
    t.advance(15_000);
    sink.close();
    t.advance(60_000);
    assert.strictEqual(
      await readAll(sink.stream),
      "data: x\n\n" + ANTHROPIC_PING_FRAME + ANTHROPIC_PING_FRAME,
    );
  });

  test("comment ping frame for other protocols", async () => {
    const t = new FakeTimers();
    const sink = new SseSink({ heartbeatFrame: COMMENT_PING_FRAME, timers: t });
    t.advance(15_000);
    sink.close();
    assert.strictEqual(await readAll(sink.stream), ": ping\n\n");
  });

  test("one cancellation source per request, disposed once", () => {
    const t = new FakeTimers();
    let created = 0;
    const src = new FakeSource();
    const scope = new RequestScope({
      requestId: "r",
      protocol: "openai",
      createSource: () => {
        created++;
        return src;
      },
      timers: t,
    });
    assert.strictEqual(scope.token, src.token);
    scope.dispose();
    scope.dispose();
    t.advance(700_000);
    assert.strictEqual(created, 1);
    assert.strictEqual(src.disposed, 1);
    assert.strictEqual(src.token.isCancellationRequested, false);
  });

  test("CollectSink drops items after cancel", () => {
    const c = new CollectSink<number>();
    c.write(1);
    c.cancel();
    assert.strictEqual(c.write(2), false);
    assert.deepStrictEqual(c.values(), [1]);
  });
});
