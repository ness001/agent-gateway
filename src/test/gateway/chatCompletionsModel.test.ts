import * as assert from "node:assert";

import {
  createChatCompletionsModel,
  toChatBody,
  toChatMessages,
} from "../../gateway/chatCompletionsModel";
import type { LocalRoutesDeps } from "../../gateway/localRoutes";
import { handle } from "../../protocol";

type Rec = Record<string, unknown>;

const sse = (chunks: unknown[]): Response =>
  new Response(
    chunks
      .map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const TOOL_TURN = [
  { choices: [{ delta: { reasoning_content: "think" } }] },
  { choices: [{ delta: { content: "Hello" } }] },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_9",
              type: "function",
              function: { name: "read", arguments: '{"p":' },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: '"b"}' } }] },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  "[DONE]",
];

function setup(reply: () => Response) {
  const calls: { url: string; headers: Headers; body: Rec }[] = [];
  const model = createChatCompletionsModel({
    id: "box--m",
    remote: { name: "box", url: "http://remote.test" },
    upstreamModelId: "m",
    info: { displayName: "[box] m", contextWindow: 100000 },
    getApiKey: async () => "k1",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body as string) as Rec,
      });
      return reply();
    }) as typeof fetch,
  });
  const deps = {
    getLocalModel: (id: string) => (id === "box--m" ? model : undefined),
    maxSearchesPerRequest: 0,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    noteRequestError() {},
  } as unknown as LocalRoutesDeps;
  return { calls, deps };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:24444${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

suite("Chat Completions translation", () => {
  test("Anthropic Messages with tool history round-trips", async () => {
    const { calls, deps } = setup(() => sse(TOOL_TURN));
    const res = await handle(
      post("/v1/messages", {
        model: "box--m",
        max_tokens: 100,
        system: "be brief",
        tools: [
          {
            name: "read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { p: { type: "string" } },
            },
          },
        ],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "read",
                input: { p: "a" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "file text",
              },
              { type: "text", text: "continue" },
            ],
          },
        ],
      }),
      deps,
    );
    assert.strictEqual(res.status, 200, await res.clone().text());
    const out = (await res.json()) as Rec;

    assert.strictEqual(calls.length, 1);
    const sent = calls[0];
    assert.strictEqual(sent.url, "http://remote.test/v1/chat/completions");
    assert.strictEqual(sent.headers.get("authorization"), "Bearer k1");
    assert.strictEqual(sent.body.model, "m");
    assert.strictEqual(sent.body.stream, true);
    assert.strictEqual(sent.body.max_tokens, 100);
    const tools = sent.body.tools as Rec[];
    assert.strictEqual((tools[0].function as Rec).name, "read");
    const msgs = sent.body.messages as Rec[];
    assert.ok(JSON.stringify(msgs[0]).includes("be brief"));
    const assistant = msgs.find((m) => m.role === "assistant")!;
    const call = (assistant.tool_calls as Rec[])[0];
    const fn = call.function as Rec;
    assert.strictEqual(fn.name, "read");
    assert.deepStrictEqual(JSON.parse(fn.arguments as string), { p: "a" });
    const toolIndex = msgs.findIndex((m) => m.role === "tool");
    assert.strictEqual(msgs[toolIndex - 1], assistant);
    assert.strictEqual(msgs[toolIndex].tool_call_id, call.id);
    assert.strictEqual(msgs[toolIndex].content, "file text");
    assert.deepStrictEqual(msgs[toolIndex + 1], {
      role: "user",
      content: "continue",
    });

    const content = out.content as Rec[];
    assert.ok(content.some((b) => b.type === "text" && b.text === "Hello"));
    const use = content.find((b) => b.type === "tool_use")!;
    assert.strictEqual(use.name, "read");
    assert.deepStrictEqual(use.input, { p: "b" });
    assert.strictEqual(out.stop_reason, "tool_use");
    assert.strictEqual((out.usage as Rec).output_tokens, 7);
  });

  test("Anthropic streaming emits text and tool_use events", async () => {
    const { deps } = setup(() => sse(TOOL_TURN));
    const res = await handle(
      post("/v1/messages", {
        model: "box--m",
        max_tokens: 100,
        stream: true,
        tools: [{ name: "read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
      deps,
    );
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"text":"Hello"/);
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"stop_reason":"tool_use"/);
  });

  test("OpenAI Responses request is translated", async () => {
    const { calls, deps } = setup(() =>
      sse([{ choices: [{ delta: { content: "Hi there" } }] }, "[DONE]"]),
    );
    const res = await handle(
      post("/v1/responses", { model: "box--m", input: "hi", stream: false }),
      deps,
    );
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.ok(JSON.stringify(await res.json()).includes("Hi there"));
    assert.ok(JSON.stringify(calls[0].body.messages).includes("hi"));
  });

  test("Gemini generateContent is translated", async () => {
    const { deps } = setup(() =>
      sse([{ choices: [{ delta: { content: "Gemini ok" } }] }, "[DONE]"]),
    );
    const res = await handle(
      post("/v1beta/models/box--m:generateContent", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
      deps,
    );
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.ok(JSON.stringify(await res.json()).includes("Gemini ok"));
  });

  test("a non-streaming JSON completion is accepted", async () => {
    const { deps } = setup(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "plain" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await handle(
      post("/v1/messages", {
        model: "box--m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
      deps,
    );
    const out = (await res.json()) as Rec;
    assert.deepStrictEqual(
      (out.content as Rec[])
        .filter((b) => b.type === "text")
        .map((b) => b.text),
      ["plain"],
    );
  });

  test("count_tokens is estimated without calling the remote", async () => {
    const { calls, deps } = setup(() => sse([]));
    const res = await handle(
      post("/v1/messages/count_tokens", {
        model: "box--m",
        messages: [{ role: "user", content: "hello world, count me" }],
      }),
      deps,
    );
    assert.strictEqual(res.status, 200);
    const out = (await res.json()) as Rec;
    assert.ok((out.input_tokens as number) > 0);
    assert.strictEqual(calls.length, 0);
  });

  test("remote HTTP errors become protocol errors", async () => {
    const { deps } = setup(
      () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
    );
    const res = await handle(
      post("/v1/messages", {
        model: "box--m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
      deps,
    );
    assert.ok(res.status === 401 || res.status === 403, String(res.status));
    const text = await res.text();
    assert.match(text, /rejected the API key/);
    assert.doesNotMatch(text, /bad key/);
  });

  test("images and required tool mode are converted", () => {
    const messages = toChatMessages([
      {
        role: 1,
        content: [
          { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          { value: "what is this" },
        ],
      },
    ]);
    assert.deepStrictEqual(messages, [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AQID" },
          },
          { type: "text", text: "what is this" },
        ],
      },
    ]);
    const body = toChatBody("m", [], {
      tools: [{ name: "t", description: "", inputSchema: undefined }],
      toolMode: 2,
      modelOptions: {},
    });
    assert.strictEqual(body.tool_choice, "required");
    assert.deepStrictEqual(body.tools, [
      {
        type: "function",
        function: { name: "t", parameters: { type: "object", properties: {} } },
      },
    ]);
  });
});
