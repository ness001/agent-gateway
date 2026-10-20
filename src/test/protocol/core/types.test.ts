import * as assert from "assert";

import type {
  CoreEvent,
  CoreRequest,
  GatewayErrorKind,
  LmChatLike,
  ModelLookup,
  NormalizedUsage,
  Part,
  ProtocolHandler,
  ToolMode,
} from "../../../protocol/core/types";
import type {
  WebFetchEngine,
  WebSearchEngine,
} from "../../../protocol/hosted/types";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const expectType = <T extends true>(_v?: T): void => undefined;

suite("protocol core types", () => {
  test("handler contract and IR types compile", async () => {
    const events: CoreEvent[] = [
      { e: "text", delta: "hi" },
      { e: "thinking", delta: "x" },
      { e: "toolCall", id: "t1", name: "f", input: {} },
      { e: "hostedCall", id: "h1", kind: "search", query: "q" },
      { e: "hostedResult", callId: "h1", sources: [{ url: "https://a" }] },
      { e: "end", reason: "stop", usage: { input: 1, output: 2 } },
      { e: "error", err: { kind: "internal", message: "m" } },
    ];
    const modes: ToolMode[] = [
      { kind: "auto" },
      { kind: "none" },
      { kind: "required", only: ["f"] },
    ];
    const parts: Part[] = [
      { type: "text", text: "a" },
      { type: "image", mime: "image/png", data: new Uint8Array() },
      { type: "toolCall", id: "c", name: "f", input: {} },
      { type: "toolResult", callId: "c", content: [], isError: false },
      { type: "thinking", text: "t" },
    ];
    const req: CoreRequest = {
      protocol: "anthropic",
      model: "m",
      echoModel: "m",
      system: [],
      turns: [{ role: "user", parts }],
      tools: [],
      toolMode: modes[0],
      hosted: [],
      stream: false,
      echo: {},
    };
    const u: NormalizedUsage = { input: 1, output: 1 };
    // @ts-expect-error unknown event names are rejected
    const bad: CoreEvent = { e: "nope" };
    expectType<
      Equals<
        GatewayErrorKind,
        | "invalid_request"
        | "not_found"
        | "permission"
        | "rate_limit"
        | "upstream_rejected"
        | "overloaded"
        | "upstream_error"
        | "timeout"
        | "tool_unavailable"
        | "unsupported"
        | "internal"
      >
    >(true);
    const lookup: ModelLookup = {
      error: { error: { message: "x", type: "y" } },
    };
    const engine: WebSearchEngine & WebFetchEngine = {
      meta: {
        id: "exa",
        label: "Exa",
        anonymousSearch: true,
        anonymousFetch: true,
        supportsFetch: true,
      },
      search: async () => [],
      fetch: async (urls) => urls.map((url) => ({ url, status: "ok" })),
    };
    expectType<
      import("vscode").LanguageModelChat extends LmChatLike ? true : false
    >(true);
    const handler: ProtocolHandler = async () => new Response("ok");
    const res = await handler(new Request("http://x/v1/messages"), {
      getLocalModel: (): LmChatLike | undefined => undefined,
      maxSearchesPerRequest: 5,
      hosted: { search: engine, fetch: engine, maxSearchesPerRequest: 5 },
    });
    assert.strictEqual(await res.text(), "ok");
    assert.strictEqual(events.length, 7);
    assert.ok(req && u && bad && lookup);
  });
});
