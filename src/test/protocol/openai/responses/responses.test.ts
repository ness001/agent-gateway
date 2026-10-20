import * as assert from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LmApi } from "../../../../protocol/core/lmRequest";
import type { TurnSink } from "../../../../protocol/core/runTurn";
import type { CoreEvent, LmChatLike } from "../../../../protocol/core/types";
import {
  ResponsesEncoder,
  type ResponsesFrame,
  decodeResponses,
  handleResponses,
} from "../../../../protocol/openai/responses";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function err(fn: () => unknown): {
  kind: string;
  message: string;
  param?: string;
  providerCode?: string;
} {
  try {
    fn();
  } catch (e) {
    return e as never;
  }
  assert.fail("expected throw");
}

class Collect implements TurnSink<ResponsesFrame> {
  frames: ResponsesFrame[] = [];
  cancelled = false;
  write(f: ResponsesFrame): boolean {
    this.frames.push(f);
    return true;
  }
  get names(): string[] {
    return this.frames.map((f) => f.event);
  }
}

function run(
  events: CoreEvent[],
  echo: Record<string, unknown> = {},
  include = false,
) {
  const enc = new ResponsesEncoder(
    { echoModel: "m-echo", echo },
    { includeEncryptedReasoning: include, now: () => 1000 },
  );
  const sink = new Collect();
  for (const ev of events) {
    enc.onEvent(ev, sink);
  }
  enc.finish(sink);
  return { enc, sink };
}

const fixturesRoot = join(__dirname, "../../../../../src/test/fixtures/wire");
function fixture(name: string): {
  body?: Record<string, unknown>;
  sse?: { events: string[] };
} {
  return JSON.parse(
    readFileSync(join(fixturesRoot, `responses-${name}.json`), "utf8"),
  );
}

suite("protocol/openai/responses decode", () => {
  test("missing input and instructions gives missing_required_parameter", () => {
    const e = err(() => decodeResponses({ model: "m" }));
    assert.strictEqual(e.kind, "invalid_request");
    assert.strictEqual(e.param, "input");
    assert.strictEqual(e.providerCode, "missing_required_parameter");
    assert.strictEqual(e.message, "Either input or instructions is required");
  });

  test("instructions alone are enough", () => {
    const d = decodeResponses({ model: "m", instructions: "be brief" });
    assert.deepStrictEqual(d.core.system, ["be brief"]);
    assert.deepStrictEqual(d.core.turns, []);
  });

  test("client tool_search: offered as a function, loaded tools become callable", () => {
    const params = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const loaded = {
      type: "function",
      name: "get_eta",
      parameters: { type: "object", properties: {} },
    };
    const infos: string[] = [];
    const d = decodeResponses(
      {
        model: "m",
        tools: [
          {
            type: "tool_search",
            execution: "client",
            description: "Find tools.",
            parameters: params,
          },
          { type: "file_search", vector_store_ids: ["v"] },
          { type: "tool_search", execution: "server" },
        ],
        input: [
          {
            type: "tool_search_call",
            execution: "client",
            call_id: "s1",
            arguments: { query: "eta" },
          },
          {
            type: "tool_search_output",
            execution: "client",
            call_id: "s1",
            tools: [loaded],
          },
        ],
      },
      {
        logger: {
          info: (m) => infos.push(m),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
    );
    assert.deepStrictEqual(
      d.core.tools.map((t) => t.name),
      ["tool_search", "get_eta"],
    );
    assert.strictEqual(d.toolSearch, true);
    assert.deepStrictEqual(d.core.turns[0].parts[0], {
      type: "toolCall",
      id: "s1",
      name: "tool_search",
      input: { query: "eta" },
    });
    assert.strictEqual(d.core.turns[1].parts[0].type, "toolResult");
    assert.match(
      infos.join("\n"),
      /dropped tool types.*file_search, tool_search/,
    );

    const enc = new ResponsesEncoder(
      { echoModel: "m", echo: {} },
      { toolSearch: true, now: () => 1000 },
    );
    const sink = new Collect();
    enc.onEvent(
      { e: "toolCall", id: "s2", name: "tool_search", input: { query: "x" } },
      sink,
    );
    enc.onEvent(
      { e: "end", reason: "tool", usage: { input: 1, output: 1 } },
      sink,
    );
    enc.finish(sink);
    const item = enc.result().output[0];
    assert.strictEqual(item.type, "tool_search_call");
    assert.deepStrictEqual(
      item.type === "tool_search_call" && {
        call_id: item.call_id,
        execution: item.execution,
        arguments: item.arguments,
      },
      { call_id: "s2", execution: "client", arguments: { query: "x" } },
    );
  });

  test("additional_tools items add tools; unknown history items are skipped", () => {
    const d = decodeResponses({
      model: "m",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "custom", name: "exec" }],
            },
          ],
        },
        { type: "configuration_update", reasoning: { effort: "high" } },
        { type: "local_shell_call", call_id: "x", action: {} },
        { role: "user", content: "hi" },
      ],
    });
    assert.deepStrictEqual(
      d.core.tools.map((t) => t.name),
      ["functions__exec"],
    );
    assert.ok(d.custom.has("functions__exec"));
    assert.deepStrictEqual(d.core.turns, [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("custom (freeform) tools round-trip as custom_tool_call", () => {
    const d = decodeResponses({
      model: "m",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files.",
          format: { type: "grammar", syntax: "lark", definition: "start: x" },
        },
      ],
      input: [
        {
          type: "custom_tool_call",
          call_id: "c1",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        { type: "custom_tool_call_output", call_id: "c1", output: "done" },
      ],
    });
    const tool = d.core.tools[0];
    assert.strictEqual(tool.name, "apply_patch");
    assert.match(
      tool.description ?? "",
      /Edit files\.[\s\S]*lark grammar:\nstart: x/,
    );
    assert.deepStrictEqual(tool.inputSchema, {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    });
    assert.deepStrictEqual(d.core.turns[0].parts[0], {
      type: "toolCall",
      id: "c1",
      name: "apply_patch",
      input: { input: "*** Begin Patch" },
    });
    assert.strictEqual(d.core.turns[1].parts[0].type, "toolResult");

    const enc = new ResponsesEncoder(
      { echoModel: "m", echo: {} },
      { custom: d.custom, now: () => 1000 },
    );
    const sink = new Collect();
    enc.onEvent(
      {
        e: "toolCall",
        id: "c2",
        name: "apply_patch",
        input: { input: "*** End Patch" },
      },
      sink,
    );
    enc.onEvent(
      { e: "end", reason: "tool", usage: { input: 1, output: 1 } },
      sink,
    );
    enc.finish(sink);
    assert.ok(sink.names.includes("response.custom_tool_call_input.done"));
    const item = enc.result().output[0];
    assert.strictEqual(item.type, "custom_tool_call");
    assert.strictEqual(
      item.type === "custom_tool_call" && item.input,
      "*** End Patch",
    );
    assert.match(item.id, /^ctc_/);
  });

  test("namespace tools are flattened and calls map back", () => {
    const d = decodeResponses({
      model: "m",
      tools: [
        {
          type: "namespace",
          name: "mcp__repl",
          description: "REPL tools.",
          tools: [
            {
              type: "function",
              name: "js",
              description: "Run JS.",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
      input: [
        {
          type: "function_call",
          call_id: "c1",
          namespace: "mcp__repl",
          name: "js",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    assert.deepStrictEqual(d.core.tools, [
      {
        name: "mcp__repl__js",
        description: "REPL tools.\n\nRun JS.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    assert.strictEqual(
      (d.core.turns[0].parts[0] as { name: string }).name,
      "mcp__repl__js",
    );
    const enc = new ResponsesEncoder(
      { echoModel: "m", echo: {} },
      { namespaced: d.namespaced, now: () => 1000 },
    );
    const sink = new Collect();
    enc.onEvent(
      { e: "toolCall", id: "c2", name: "mcp__repl__js", input: {} },
      sink,
    );
    enc.onEvent(
      { e: "end", reason: "tool", usage: { input: 1, output: 1 } },
      sink,
    );
    enc.finish(sink);
    const item = enc.result().output[0];
    assert.strictEqual(item.type === "function_call" && item.name, "js");
    assert.strictEqual(
      item.type === "function_call" && item.namespace,
      "mcp__repl",
    );
  });

  test("string input becomes one user turn", () => {
    const d = decodeResponses({ model: "m", input: "ping" });
    assert.deepStrictEqual(d.core.turns, [
      { role: "user", parts: [{ type: "text", text: "ping" }] },
    ]);
    assert.strictEqual(d.core.protocol, "openai-responses");
    assert.strictEqual(d.core.stream, false);
  });

  test("instructions, system and developer messages become the system prompt", () => {
    const d = decodeResponses({
      model: "m",
      instructions: "I",
      input: [
        { role: "system", content: "S" },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "D" }],
        },
        { role: "user", content: [{ type: "input_text", text: "U" }] },
        { role: "assistant", content: [{ type: "output_text", text: "A" }] },
      ],
    });
    assert.deepStrictEqual(d.core.system, ["I", "S", "D"]);
    assert.deepStrictEqual(
      d.core.turns.map((t) => t.role),
      ["user", "assistant"],
    );
  });

  test("input_image data URL decoded and sniffed", () => {
    const d = decodeResponses({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${PNG.toString("base64")}`,
            },
          ],
        },
      ],
    });
    const p = d.core.turns[0].parts[0];
    assert.strictEqual(p.type, "image");
    assert.strictEqual(p.type === "image" && p.mime, "image/png");
  });

  test("remote input_image, file_id image and input_file become text", () => {
    const d = decodeResponses({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://x/y.png" },
            { type: "input_image", file_id: "file-9", detail: "high" },
            {
              type: "input_file",
              filename: "a.pdf",
              file_data: "data:application/pdf;base64,AAAAAAAA",
            },
          ],
        },
      ],
    });
    assert.deepStrictEqual(d.core.turns[0].parts, [
      {
        type: "text",
        text: '{"type":"input_image","image_url":"https://x/y.png"}',
        imageUrl: "https://x/y.png",
      },
      {
        type: "text",
        text: '{"type":"input_image","file_id":"file-9","detail":"high"}',
      },
      {
        type: "text",
        text: '{"type":"input_file","filename":"a.pdf","file_data":"<omitted 6 bytes>"}',
      },
    ]);
    const bad = err(() =>
      decodeResponses({
        model: "m",
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,!!" },
            ],
          },
        ],
      }),
    );
    assert.strictEqual(bad.kind, "invalid_request");
  });

  test("function_call and function_call_output pair up", () => {
    const d = decodeResponses({
      model: "m",
      input: [
        { role: "user", content: "weather?" },
        {
          type: "function_call",
          call_id: "c1",
          name: "w",
          arguments: '{"city":"Paris"}',
        },
        { type: "function_call", call_id: "c2", name: "w", arguments: "" },
        { type: "function_call_output", call_id: "c1", output: "sunny" },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [{ type: "input_text", text: "rain" }],
        },
      ],
    });
    assert.strictEqual(d.core.turns.length, 3);
    assert.deepStrictEqual(d.core.turns[1].parts, [
      { type: "toolCall", id: "c1", name: "w", input: { city: "Paris" } },
      { type: "toolCall", id: "c2", name: "w", input: {} },
    ]);
    assert.deepStrictEqual(d.core.turns[2].parts[0], {
      type: "toolResult",
      callId: "c1",
      content: [{ type: "text", text: "sunny" }],
      isError: false,
    });
  });

  test("malformed function_call arguments give 400 with path", () => {
    const e = err(() =>
      decodeResponses({
        model: "m",
        input: [
          { type: "function_call", call_id: "c", name: "w", arguments: "{" },
        ],
      }),
    );
    assert.strictEqual(e.param, "input[0].arguments");
  });

  test("reasoning items replay encrypted_content; web_search_call tolerated", () => {
    const d = decodeResponses({
      model: "m",
      input: [
        { role: "user", content: "q" },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "t" }],
          encrypted_content: "SIG",
        },
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "x" },
        },
        { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      ],
    });
    assert.deepStrictEqual(d.core.turns[1].parts, [
      { type: "thinking", text: "t", signature: "SIG" },
      { type: "text", text: "a" },
    ]);
  });

  test("an item without a type string gives 400 with path", () => {
    const e = err(() => decodeResponses({ model: "m", input: [{ type: 7 }] }));
    assert.strictEqual(e.param, "input[0].type");
  });

  test("tool_choice maps to ToolMode", () => {
    const tools = [
      { type: "function", name: "a", parameters: { type: "object" } },
      { type: "function", name: "b" },
    ];
    const m = (tc: unknown) =>
      decodeResponses({ model: "m", input: "x", tools, tool_choice: tc }).core
        .toolMode;
    assert.deepStrictEqual(m(undefined), { kind: "auto" });
    assert.deepStrictEqual(m("auto"), { kind: "auto" });
    assert.deepStrictEqual(m("none"), { kind: "none" });
    assert.deepStrictEqual(m("required"), { kind: "required" });
    assert.deepStrictEqual(m({ type: "function", name: "b" }), {
      kind: "required",
      only: ["b"],
    });
    assert.deepStrictEqual(
      m({
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "a" }],
      }),
      { kind: "required", only: ["a"] },
    );
    assert.strictEqual(
      err(() => m({ type: "function", name: "zz" })).param,
      "tool_choice.name",
    );
    assert.strictEqual(err(() => m("sometimes")).param, "tool_choice");
  });

  test("function tools decoded; optional hosted web_search dropped without a provider", () => {
    const d = decodeResponses({
      model: "m",
      input: "x",
      tools: [
        {
          type: "function",
          name: "w",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    assert.deepStrictEqual(d.core.tools, [
      {
        name: "w",
        description: "d",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const dropped = decodeResponses({
      model: "m",
      input: "x",
      tools: [{ type: "web_search" }],
    });
    assert.deepStrictEqual(dropped.core.hosted, []);
    assert.deepStrictEqual(dropped.core.tools, []);
    // Built-in tools the LM API cannot run are dropped, not rejected.
    assert.deepStrictEqual(
      decodeResponses({
        model: "m",
        input: "x",
        tools: [{ type: "file_search" }],
      }).core.tools,
      [],
    );
  });

  test("previous_response_id gives 400 unsupported", () => {
    const e = err(() =>
      decodeResponses({
        model: "m",
        input: "x",
        previous_response_id: "resp_1",
      }),
    );
    assert.strictEqual(e.kind, "unsupported");
    assert.strictEqual(e.param, "previous_response_id");
  });

  test("settings: limits, reasoning, include, cache key, parallel, metadata ignored", () => {
    const d = decodeResponses({
      model: "m",
      input: "x",
      max_output_tokens: 100,
      max_tool_calls: 3,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "k1",
      parallel_tool_calls: false,
      store: false,
      metadata: { a: "b" },
      stream: true,
    });
    assert.strictEqual(d.core.maxOutputTokens, 100);
    assert.strictEqual(d.core.reasoningEffort, "high");
    assert.strictEqual(d.core.cacheKey, "k1");
    assert.strictEqual(d.core.parallelToolCalls, false);
    assert.strictEqual(d.core.stream, true);
    assert.strictEqual(d.includeEncryptedReasoning, true);
    assert.strictEqual(d.reasoningSummary, "auto");
    assert.deepStrictEqual(d.core.echo.reasoning, {
      effort: "high",
      summary: "auto",
    });
    assert.strictEqual(d.core.echo.max_tool_calls, 3);
    assert.strictEqual(d.core.maxToolCalls, 3);
    assert.strictEqual(d.core.reasoningSummary, "auto");
    assert.strictEqual("metadata" in d.core.echo, false);
  });

  test("no output limit sends none", () => {
    const d = decodeResponses({ model: "m", input: "x" });
    assert.strictEqual("maxOutputTokens" in d.core, false);
    assert.strictEqual(
      err(() =>
        decodeResponses({ model: "m", input: "x", max_output_tokens: 0 }),
      ).param,
      "max_output_tokens",
    );
  });

  test("model name is echoed unchanged", () => {
    const d = decodeResponses({ model: "gpt-6-astra", input: "x" });
    assert.strictEqual(d.core.echoModel, "gpt-6-astra");
  });
});

suite("protocol/openai/responses encode", () => {
  test("text stream event order matches fixture", () => {
    const { sink } = run([
      { e: "text", delta: "po" },
      { e: "text", delta: "ng" },
      { e: "end", reason: "stop" },
    ]);
    const fx = fixture("stream").sse!.events;
    const dedup = sink.names.filter(
      (n, i, a) => !(n === "response.output_text.delta" && a[i - 1] === n),
    );
    assert.deepStrictEqual(dedup, fx);
  });

  test("sequence_number starts at 0 and increases by 1", () => {
    const { sink } = run([
      { e: "text", delta: "a" },
      { e: "end", reason: "stop" },
    ]);
    sink.frames.forEach((f, i) => {
      assert.strictEqual(f.data.sequence_number, i);
      assert.strictEqual(f.data.type, f.event);
    });
  });

  test("snapshot defaults on response.created", () => {
    const { sink } = run([{ e: "end", reason: "stop" }]);
    const r = sink.frames[0].data.response as Record<string, unknown>;
    assert.strictEqual(r.status, "in_progress");
    assert.strictEqual(r.parallel_tool_calls, true);
    assert.deepStrictEqual(r.reasoning, { effort: "none", summary: null });
    assert.strictEqual(r.tool_choice, "auto");
    assert.strictEqual(r.usage, null);
    assert.deepStrictEqual(r.output, []);
    assert.strictEqual(r.model, "m-echo");
  });

  test("deltas concatenate to the final text", () => {
    const { sink, enc } = run([
      { e: "text", delta: "Hel" },
      { e: "text", delta: "lo" },
      { e: "end", reason: "stop" },
    ]);
    const deltas = sink.frames
      .filter((f) => f.event === "response.output_text.delta")
      .map((f) => f.data.delta)
      .join("");
    const done = sink.frames.find(
      (f) => f.event === "response.output_text.done",
    )!;
    assert.strictEqual(deltas, "Hello");
    assert.strictEqual(done.data.text, "Hello");
    const msg = enc.result().output[0];
    assert.strictEqual(msg.type === "message" && msg.content[0].text, "Hello");
  });

  test("non-stream object shape matches fixture keys", () => {
    const { enc } = run([
      { e: "text", delta: "pong" },
      { e: "end", reason: "stop", usage: { input: 349, output: 4 } },
    ]);
    const r = enc.result();
    const fx = fixture("nonstream").body!;
    for (const k of Object.keys(fx)) {
      assert.ok(k in r, `missing ${k}`);
    }
    assert.match(r.id, /^resp_/);
    assert.strictEqual(r.status, "completed");
    assert.strictEqual(r.completed_at, 1000);
    const item = r.output[0];
    assert.strictEqual(item.type, "message");
    assert.match(item.id, /^msg_/);
    assert.deepStrictEqual(item.type === "message" && item.content, [
      { type: "output_text", text: "pong", annotations: [] },
    ]);
    assert.deepStrictEqual(r.usage, fx.usage);
  });

  test("usage details present when 0 and cached/reasoning passed through", () => {
    const { enc } = run([
      {
        e: "end",
        reason: "stop",
        usage: { input: 10, output: 5, cacheRead: 7, reasoning: 2 },
      },
    ]);
    assert.deepStrictEqual(enc.result().usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 7, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
    });
  });

  test("parallel function calls match fixture order with distinct output_index", () => {
    const { sink, enc } = run([
      { e: "toolCall", id: "call_1", name: "w", input: { city: "Paris" } },
      { e: "toolCall", id: "call_2", name: "w", input: { city: "Tokyo" } },
      { e: "end", reason: "tool" },
    ]);
    assert.deepStrictEqual(
      sink.names,
      fixture("tool-parallel-stream").sse!.events,
    );
    const idx = sink.frames
      .filter((f) => f.event === "response.output_item.added")
      .map((f) => f.data.output_index);
    assert.deepStrictEqual(idx, [0, 1]);
    const args = sink.frames
      .filter((f) => f.event === "response.function_call_arguments.delta")
      .map((f) => f.data.delta)
      .join("");
    assert.strictEqual(args, '{"city":"Paris"}{"city":"Tokyo"}');
    const out = enc.result().output;
    assert.strictEqual(
      out[0].type === "function_call" && out[0].call_id,
      "call_1",
    );
    assert.match(out[0].id, /^fc_/);
    assert.strictEqual(enc.result().status, "completed");
  });

  test("function_call item matches fixture shape", () => {
    const { enc } = run([
      {
        e: "toolCall",
        id: "toolu_x",
        name: "get_weather",
        input: { city: "Paris" },
      },
      { e: "end", reason: "tool" },
    ]);
    const fx = (
      fixture("tool-single").body!.output as Array<Record<string, unknown>>
    )[0];
    const item = enc.result().output[0] as unknown as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(item).sort(), Object.keys(fx).sort());
    assert.strictEqual(item.arguments, fx.arguments);
    assert.strictEqual(item.status, "completed");
  });

  test("text then tool call closes the message item first", () => {
    const { sink } = run([
      { e: "text", delta: "x" },
      { e: "toolCall", id: "c", name: "n", input: {} },
      { e: "end", reason: "tool" },
    ]);
    const i = sink.names.indexOf("response.function_call_arguments.delta");
    assert.ok(sink.names.lastIndexOf("response.output_text.done") < i);
    assert.ok(sink.names.indexOf("response.output_item.done") < i);
  });

  test("no reasoning.summary gives a reasoning item without summary text", () => {
    const enc = new ResponsesEncoder(
      { echoModel: "m", echo: {} },
      { summary: false, now: () => 1000 },
    );
    const sink = new Collect();
    for (const ev of [
      { e: "thinking", delta: "secret" },
      { e: "text", delta: "a" },
      { e: "end", reason: "stop", usage: { input: 1, output: 1 } },
    ] as CoreEvent[]) {
      enc.onEvent(ev, sink);
    }
    enc.finish(sink);
    assert.ok(!sink.names.some((n) => n.includes("reasoning_summary")));
    const r = enc.result().output[0];
    assert.match(r.id, /^rs_[0-9a-z]{4}/);
    assert.deepStrictEqual(r.type === "reasoning" && r.summary, []);
  });

  test("thinking stream emits a reasoning item with summary events", () => {
    const { sink, enc } = run(
      [
        { e: "thinking", delta: "hm" },
        { e: "thinking", delta: "m", signature: "SIG" },
        { e: "text", delta: "a" },
        {
          e: "end",
          reason: "stop",
          usage: { input: 1, output: 2, reasoning: 1 },
        },
      ],
      {},
      true,
    );
    assert.deepStrictEqual(sink.names.slice(2, 8), [
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    const r = enc.result().output[0];
    assert.strictEqual(r.type, "reasoning");
    assert.match(r.id, /^rs_/);
    assert.deepStrictEqual(r.type === "reasoning" && r.summary, [
      { type: "summary_text", text: "hmm" },
    ]);
    assert.strictEqual(r.type === "reasoning" && r.encrypted_content, "SIG");
    assert.strictEqual(enc.result().output[1].type, "message");
  });

  test("encrypted_content omitted unless included", () => {
    const { enc } = run([
      { e: "thinking", delta: "t", signature: "SIG" },
      { e: "end", reason: "stop" },
    ]);
    assert.strictEqual("encrypted_content" in enc.result().output[0], false);
  });

  test("reasoning echoed in snapshot", () => {
    const { sink } = run([{ e: "end", reason: "stop" }], {
      reasoning: { effort: "high", summary: "auto" },
    });
    assert.deepStrictEqual(
      (sink.frames[0].data.response as Record<string, unknown>).reasoning,
      { effort: "high", summary: "auto" },
    );
  });

  test("length end gives response.incomplete", () => {
    const { sink, enc } = run([
      { e: "text", delta: "a" },
      { e: "end", reason: "length", usage: { input: 1, output: 16 } },
    ]);
    assert.strictEqual(
      sink.names[sink.names.length - 1],
      "response.incomplete",
    );
    assert.strictEqual(enc.result().status, "incomplete");
    assert.deepStrictEqual(enc.result().incomplete_details, {
      reason: "max_output_tokens",
    });
  });

  test("normal stop never reports incomplete", () => {
    const { sink } = run([
      { e: "text", delta: "a" },
      { e: "end", reason: "stop", usage: { input: 1, output: 999 } },
    ]);
    assert.ok(!sink.names.includes("response.incomplete"));
  });

  test("mid-stream error emits response.failed and nothing after", () => {
    const { sink, enc } = run([
      { e: "text", delta: "a" },
      { e: "error", err: { kind: "upstream_error", message: "boom" } },
      { e: "text", delta: "late" },
    ]);
    assert.strictEqual(sink.names[sink.names.length - 1], "response.failed");
    assert.strictEqual(
      sink.names.filter(
        (n) => n.startsWith("response.failed") || n === "response.completed",
      ).length,
      1,
    );
    assert.deepStrictEqual(enc.result().error, {
      code: "server_error",
      message: "boom",
    });
  });

  test("finish without end still completes once", () => {
    const enc = new ResponsesEncoder({ echoModel: "m", echo: {} });
    const sink = new Collect();
    enc.finish(sink);
    enc.finish(sink);
    assert.deepStrictEqual(sink.names, [
      "response.created",
      "response.in_progress",
      "response.completed",
    ]);
  });
});

// ---- handler with a fake LM ----

class TextPart {
  constructor(public value: string) {}
}
class ToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
class ToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
const api: LmApi = {
  LanguageModelChatMessage: {
    User: (content) => ({ role: "user", content }),
    Assistant: (content) => ({ role: "assistant", content }),
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: { image: (data, mime) => ({ data, mimeType: mime }) },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};

function fakeModel(
  parts: unknown[],
  seen: { options?: unknown } = {},
  fail?: Error,
): LmChatLike {
  return {
    id: "m",
    maxInputTokens: 1000,
    sendRequest: async (_m, options) => {
      seen.options = options;
      if (fail) {
        throw fail;
      }
      return {
        stream: (async function* () {
          for (const p of parts) {
            yield p;
          }
        })(),
      };
    },
    countTokens: async () => 1,
  };
}

const source = () => ({
  token: { isCancellationRequested: false },
  cancel() {},
  dispose() {},
});
const usagePart = {
  mimeType: "usage",
  data: new TextEncoder().encode(
    JSON.stringify({ prompt_tokens: 12, completion_tokens: 7 }),
  ),
};

function post(body: unknown): Request {
  return new Request("http://x/v1/responses", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

suite("protocol/openai/responses handler", () => {
  test("non-stream JSON response", async () => {
    const seen: { options?: unknown } = {};
    const res = await handleResponses(
      post({ model: "m", input: "hi", prompt_cache_key: "ck" }),
      {
        getLocalModel: () => fakeModel([new TextPart("pong"), usagePart], seen),
        api,
        createSource: source,
      },
      "req_1",
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-request-id"), "req_1");
    const j = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(j.status, "completed");
    assert.strictEqual((j.usage as Record<string, unknown>).total_tokens, 19);
    const mo = (seen.options as { modelOptions: Record<string, unknown> })
      .modelOptions;
    assert.ok(
      Object.values(mo).includes("ck"),
      "prompt_cache_key forwarded as cache key",
    );
  });

  test("stream response uses event: lines", async () => {
    const res = await handleResponses(
      post({ model: "m", input: "hi", stream: true }),
      {
        getLocalModel: () =>
          fakeModel([new TextPart("po"), new TextPart("ng"), usagePart]),
        api,
        createSource: source,
      },
      "req_2",
    );
    assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    assert.strictEqual(events[0], "response.created");
    assert.strictEqual(events[events.length - 1], "response.completed");
    assert.ok(text.includes('"sequence_number":0'));
  });

  test("invalid body and malformed JSON give 400 envelope", async () => {
    const deps = {
      getLocalModel: () => fakeModel([]),
      api,
      createSource: source,
    };
    const a = await handleResponses(post({ model: "m" }), deps, "r");
    assert.strictEqual(a.status, 400);
    const fx = fixture("invalid").body as { error: Record<string, unknown> };
    const ja = (await a.json()) as { error: Record<string, unknown> };
    assert.deepStrictEqual({ ...ja.error }, { ...fx.error });
    const b = await handleResponses(post("{nope"), deps, "r");
    assert.strictEqual(b.status, 400);
    const jb = (await b.json()) as { error: Record<string, unknown> };
    assert.strictEqual(jb.error.type, "invalid_request_error");
  });

  test("LM failure before stream gives error response (non-stream)", async () => {
    const res = await handleResponses(
      post({ model: "m", input: "hi" }),
      {
        getLocalModel: () => fakeModel([], {}, new Error("kaput")),
        api,
        createSource: source,
      },
      "r",
    );
    assert.ok(res.status >= 400);
  });

  test("LM failure in stream gives response.failed", async () => {
    const res = await handleResponses(
      post({ model: "m", input: "hi", stream: true }),
      {
        getLocalModel: () => fakeModel([], {}, new Error("kaput")),
        api,
        createSource: source,
      },
      "r",
    );
    const text = await res.text();
    assert.ok(text.includes("event: response.failed"));
    assert.ok(!text.includes("response.completed"));
  });

  test("unresolved model gives 404 not_found", async () => {
    const res = await handleResponses(
      post({ model: "zz", input: "hi" }),
      { getLocalModel: () => undefined, api, createSource: source },
      "r",
    );
    assert.strictEqual(res.status, 404);
  });
});
