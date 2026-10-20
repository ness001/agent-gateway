import * as assert from "assert";

import { createSafeLogger, sanitizeMeta } from "../../../protocol/core/log";
import type { CoreLogger } from "../../../protocol/core/types";

function capture(): { sink: CoreLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (l: string) => (m: string) => lines.push(`${l} ${m}`);
  return {
    lines,
    sink: {
      error: push("error"),
      warn: push("warn"),
      info: push("info"),
      debug: push("debug"),
    },
  };
}

suite("protocol/core/log", () => {
  test("type rejects prompt text and free messages", () => {
    const { sink } = capture();
    const log = createSafeLogger(sink);
    // @ts-expect-error prompt is not an allow-listed key
    log.info("request.start", { prompt: "secret" });
    // @ts-expect-error free-form messages are not allowed
    log.info("user said secret");
    // @ts-expect-error tool arguments are not allowed
    log.info("tool.call", { toolName: "t", arguments: "{}" });
  });

  test("type rejects queries, URLs and image data", () => {
    const log = createSafeLogger(undefined);
    // @ts-expect-error query is not allowed
    log.info("hosted.search", { query: "q" });
    // @ts-expect-error url is not allowed
    log.info("hosted.fetch", { url: "https://x" });
    // @ts-expect-error image data is not allowed
    log.debug("tool.result", { data: new Uint8Array(1) });
  });

  test("capture writes only allow-listed metadata", () => {
    const { sink, lines } = capture();
    const log = createSafeLogger(sink, {
      requestId: "r1",
      protocol: "anthropic",
    });
    log.info("request.end", {
      status: 200,
      durationMs: 12,
      model: "gpt-4o",
      callId: "c_1",
      toolName: "Read",
    });
    const smuggled = {
      requestId: "r2",
      prompt: "SECRET PROMPT",
      query: "SECRET QUERY",
    };
    log.warn("request.error", smuggled);
    assert.deepStrictEqual(lines, [
      "info request.end requestId=r1 protocol=anthropic model=gpt-4o toolName=Read callId=c_1 status=200 durationMs=12",
      "warn request.error requestId=r2 protocol=anthropic",
    ]);
  });

  test("URL or text in an id field is dropped at runtime", () => {
    const out = sanitizeMeta({
      kind: "https://evil/x?q=1",
      model: "has spaces in it",
      engine: "exa",
      resultCount: 3,
      count: NaN,
    });
    assert.deepStrictEqual(out, { engine: "exa", resultCount: 3 });
  });
});
