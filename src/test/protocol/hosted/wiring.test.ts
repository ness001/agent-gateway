import * as assert from "node:assert/strict";

import { handleAnthropic } from "../../../protocol/anthropic";
import { decodeMessagesRequest } from "../../../protocol/anthropic/decode";
import type { LmApi } from "../../../protocol/core/lmRequest";
import type {
  CoreLogger,
  LmChatLike,
  ProtocolDeps,
} from "../../../protocol/core/types";
import { handleGemini } from "../../../protocol/gemini";
import { decodeGeminiRequest } from "../../../protocol/gemini/decode";
import {
  INTERNAL_FETCH_TOOL_BASE,
  INTERNAL_SEARCH_TOOL_BASE,
} from "../../../protocol/hosted/searchLoop";
import type {
  HostedEngines,
  SearchResult,
} from "../../../protocol/hosted/types";
import { handleResponses } from "../../../protocol/openai/responses";
import { decodeResponses } from "../../../protocol/openai/responses/decode";

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
const source = () => ({
  token: { isCancellationRequested: false },
  cancel() {},
  dispose() {},
});

const T = INTERNAL_SEARCH_TOOL_BASE;
const SECRET_QUERY = "secret-query-xyz";
const SECRET_URL = "https://example.com/secret-page";

/** Scripted model: one array of stream parts per round; records offered tools. */
function scripted(rounds: unknown[][]) {
  const offered: string[][] = [];
  let round = 0;
  const model: LmChatLike = {
    id: "m",
    maxInputTokens: 100000,
    sendRequest: async (_msgs, options) => {
      const tools = ((options as { tools?: Array<{ name: string }> }).tools ??
        []) as Array<{ name: string }>;
      offered.push(tools.map((t) => t.name));
      const parts = rounds[Math.min(round++, rounds.length - 1)];
      return {
        stream: (async function* () {
          for (const p of parts) yield p;
        })(),
      };
    },
    countTokens: async () => 1,
  };
  return { model, offered, calls: () => round };
}

function engines(results?: SearchResult[]): HostedEngines & {
  queries: string[];
} {
  const queries: string[] = [];
  const meta = {
    id: "exa" as const,
    label: "Exa",
    anonymousSearch: true,
    anonymousFetch: true,
    supportsFetch: true,
  };
  return {
    queries,
    maxSearchesPerRequest: 5,
    search: {
      meta,
      async search(q) {
        queries.push(q);
        return (
          results ?? [
            { url: SECRET_URL, title: "Secret", snippet: "the answer is 42" },
          ]
        );
      },
    },
    fetch: {
      meta,
      async fetch(urls) {
        return urls.map((url) => ({
          url,
          status: "ok" as const,
          title: "Page",
          text: "page text",
        }));
      },
    },
  };
}

function captureLogger(): CoreLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  return { lines, error: push, warn: push, info: push, debug: push };
}

const saveYear = {
  name: "save_year",
  description: "Save a year",
  input_schema: {
    type: "object",
    properties: { year: { type: "number" } },
  },
};

function anthropicPost(body: unknown): Request {
  return new Request("http://x/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

suite("protocol/hosted wiring (decoders)", () => {
  test("Anthropic web_search_YYYYMMDD becomes a hosted search tool with options", () => {
    const r = decodeMessagesRequest(
      {
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 2,
            allowed_domains: ["a.com"],
          },
        ],
      },
      { hostedSearch: true },
    );
    assert.deepEqual(r.hosted, [
      {
        kind: "search",
        wireType: "web_search_20250305",
        maxUses: 2,
        allowedDomains: ["a.com"],
      },
    ]);
    assert.deepEqual(r.tools, []);
  });

  test("Anthropic forced web_search without a provider is 400 tool_unavailable", () => {
    assert.throws(
      () =>
        decodeMessagesRequest({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          tool_choice: { type: "tool", name: "web_search" },
        }),
      (e: { kind?: string; message?: string }) =>
        e.kind === "tool_unavailable" &&
        /Web Search and Fetch/.test(e.message ?? ""),
    );
  });

  test("Anthropic forced web_search with a provider marks the tool forced", () => {
    const r = decodeMessagesRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "tool", name: "web_search" },
      },
      { hostedSearch: true },
    );
    assert.equal(r.hosted[0].kind === "search" && r.hosted[0].forced, true);
    assert.deepEqual(r.toolMode, { kind: "auto" });
  });

  test("Anthropic web_fetch is a hosted fetch tool with an engine, dropped or 400 without", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 2,
          allowed_domains: ["example.com"],
        },
      ],
    };
    const r = decodeMessagesRequest(body, { hostedSearch: true });
    assert.deepEqual(r.hosted, [
      {
        kind: "fetch",
        wireType: "web_fetch_20250910",
        asTool: true,
        maxUses: 2,
        allowedDomains: ["example.com"],
      },
    ]);
    assert.deepEqual(r.tools, []);
    assert.deepEqual(decodeMessagesRequest(body, {}).hosted, []);
    assert.throws(
      () =>
        decodeMessagesRequest(
          { ...body, tool_choice: { type: "tool", name: "web_fetch" } },
          {},
        ),
      (e: { kind?: string }) => e.kind === "tool_unavailable",
    );
  });

  test("Anthropic earlier server_tool_use / web_search_tool_result history is accepted", () => {
    const r = decodeMessagesRequest({
      model: "m",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "x" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [],
            },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "more" },
      ],
    });
    assert.deepEqual(r.turns[1].parts, [{ type: "text", text: "answer" }]);
  });

  test("Responses web_search, web_search_preview and dated forms are recognised", () => {
    for (const type of [
      "web_search",
      "web_search_preview",
      "web_search_2025_08_26",
      "web_search_preview_2025_03_11",
    ]) {
      const d = decodeResponses(
        { model: "m", input: "x", tools: [{ type }] },
        { hostedSearch: true },
      );
      assert.deepEqual(d.core.hosted, [{ kind: "search", wireType: type }]);
    }
  });

  test("Responses external_web_access:false drops the tool", () => {
    const d = decodeResponses(
      {
        model: "m",
        input: "x",
        tools: [{ type: "web_search", external_web_access: false }],
      },
      { hostedSearch: true },
    );
    assert.deepEqual(d.core.hosted, []);
  });

  test("Responses forced web_search without a provider is 400 tool_unavailable", () => {
    assert.throws(
      () =>
        decodeResponses({
          model: "m",
          input: "x",
          tools: [{ type: "web_search" }],
          tool_choice: { type: "web_search" },
        }),
      (e: { kind?: string }) => e.kind === "tool_unavailable",
    );
  });

  test("Responses function tool named web_search passes through untouched", () => {
    const d = decodeResponses(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "function",
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { hostedSearch: true },
    );
    assert.deepEqual(d.core.hosted, []);
    assert.equal(d.core.tools[0].name, "web_search");
  });

  test("Gemini googleSearch, googleSearchRetrieval and snake_case forms are recognised", () => {
    const ctx = {
      model: "m",
      echoModel: "g",
      stream: false,
      hostedSearch: true,
    };
    const body = (tool: object) => ({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [tool],
    });
    for (const [tool, wire] of [
      [{ googleSearch: {} }, "googleSearch"],
      [{ google_search: {} }, "googleSearch"],
      [{ googleSearchRetrieval: {} }, "googleSearchRetrieval"],
      [{ google_search_retrieval: {} }, "googleSearchRetrieval"],
    ] as const) {
      const r = decodeGeminiRequest(body(tool), ctx);
      assert.deepEqual(r.hosted, [{ kind: "search", wireType: wire }]);
    }
    for (const tool of [{ urlContext: {} }, { url_context: {} }]) {
      const r = decodeGeminiRequest(body(tool), ctx);
      assert.deepEqual(r.hosted, [{ kind: "fetch", wireType: "urlContext" }]);
    }
  });

  test("Gemini search tool next to functions is dropped without a provider", () => {
    const r = decodeGeminiRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          { googleSearch: {} },
          { functionDeclarations: [{ name: "f" }] },
        ],
      },
      { model: "m", echoModel: "g", stream: false },
    );
    assert.deepEqual(r.hosted, []);
    assert.equal(r.tools.length, 1);
  });

  test("Gemini urlContext mixed with function declarations is dropped", () => {
    const r = decodeGeminiRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ urlContext: {} }, { functionDeclarations: [{ name: "f" }] }],
      },
      { model: "m", echoModel: "g", stream: false, hostedSearch: true },
    );
    assert.deepEqual(r.hosted, []);
  });
});

suite("protocol/hosted wiring (handlers)", () => {
  test("Anthropic web_fetch: the gateway fetches a URL from the user message", async () => {
    const F = INTERNAL_FETCH_TOOL_BASE;
    const url = "https://example.com/doc";
    const m = scripted([
      [new ToolCallPart("f1", F, { url })],
      [new TextPart("The page says hello.")],
    ]);
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: `summarise ${url}` }],
        tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: engines() },
      "req_f",
      { api, createSource: source },
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as {
      content: Array<Record<string, unknown>>;
      usage: { server_tool_use: Record<string, number> | null };
    };
    assert.deepEqual(m.offered[0], [F]);
    assert.deepEqual(
      j.content.map((b) => b.type),
      ["server_tool_use", "web_fetch_tool_result", "text"],
    );
    assert.equal(j.content[0].name, "web_fetch");
    assert.deepEqual(j.content[0].input, { url });
    const result = j.content[1].content as {
      type: string;
      url: string;
      content: { source: { data: string } };
    };
    assert.equal(result.type, "web_fetch_result");
    assert.equal(result.url, url);
    assert.equal(result.content.source.data, "page text");
    assert.deepEqual(j.usage.server_tool_use, {
      web_search_requests: 0,
      web_fetch_requests: 1,
    });
  });

  test("Anthropic web_fetch refuses URLs not in the conversation and private hosts", async () => {
    const F = INTERNAL_FETCH_TOOL_BASE;
    const m = scripted([
      [
        new ToolCallPart("f1", F, { url: "https://attacker.example/x?d=1" }),
        new ToolCallPart("f2", F, { url: "http://127.0.0.1/admin" }),
      ],
      [new TextPart("ok")],
    ]);
    let fetched = 0;
    const eng = engines();
    const inner = eng.fetch!;
    eng.fetch = {
      meta: inner.meta,
      fetch: (urls, signal) => {
        fetched++;
        return inner.fetch(urls, signal);
      },
    };
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "see http://127.0.0.1/admin" }],
        tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: eng },
      "req_g",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      content: Array<{ type: string; content?: { error_code?: string } }>;
    };
    const errors = j.content
      .filter((b) => b.type === "web_fetch_tool_result")
      .map((b) => b.content?.error_code);
    assert.deepEqual(errors, ["url_not_in_prior_context", "url_not_allowed"]);
    assert.equal(fetched, 0);
  });

  test("Anthropic: client tools offered every round; turn ends with the client tool call", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: SECRET_QUERY })],
      [
        new TextPart("Found it [1]. "),
        new ToolCallPart("c2", "save_year", { year: 42 }),
      ],
    ]);
    const eng = engines();
    const log = captureLogger();
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "search then save" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }, saveYear],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: eng },
      "req_a",
      { api, createSource: source, logger: log },
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
      usage: { server_tool_use: { web_search_requests: number } | null };
    };
    assert.deepEqual(m.offered, [
      ["save_year", T],
      ["save_year", T],
    ]);
    assert.equal(j.stop_reason, "tool_use");
    const types = j.content.map((b) => b.type);
    assert.deepEqual(types, [
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "tool_use",
    ]);
    assert.match(String(j.content[0].id), /^srvtoolu_/);
    assert.equal(j.content[1].tool_use_id, j.content[0].id);
    assert.deepEqual(j.content[0].input, { query: SECRET_QUERY });
    const citations = j.content[2].citations as Array<{ url: string }>;
    assert.equal(citations[0].url, SECRET_URL);
    assert.equal(j.content[3].name, "save_year");
    assert.deepEqual(j.usage.server_tool_use, { web_search_requests: 1 });
    assert.deepEqual(eng.queries, [SECRET_QUERY]);
    const all = log.lines.join("\n");
    assert.ok(!all.includes(SECRET_QUERY));
    assert.ok(!all.includes(SECRET_URL));
    assert.ok(!all.includes("the answer is 42"));
    assert.ok(/hosted=web_search_20250305/.test(all), all);
  });

  test("failed search is an error result and is not counted in web_search_requests", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new TextPart("no luck")],
    ]);
    const eng = engines();
    eng.search!.search = async () => {
      throw new Error("boom");
    };
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "q" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: eng },
      "req_b",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
      usage: { server_tool_use: unknown };
    };
    assert.equal(j.stop_reason, "end_turn");
    assert.equal(
      (j.content[1].content as { type: string }).type,
      "web_search_tool_result_error",
    );
    assert.equal(j.usage.server_tool_use, null);
  });

  test("Anthropic optional web_search without a provider is dropped and the model answers", async () => {
    const m = scripted([[new TextPart("hi")]]);
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "q" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model },
      "req_c",
      { api, createSource: source },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(m.offered, [[]]);
  });

  test("Responses: web_search_call item, url_citation, then function_call item", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: SECRET_QUERY })],
      [
        new TextPart("See [1]."),
        new ToolCallPart("call_2", "save_year", { year: 42 }),
      ],
    ]);
    const res = await handleResponses(
      new Request("http://x/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          input: "search then save",
          tools: [
            { type: "web_search" },
            {
              type: "function",
              name: "save_year",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      }),
      {
        getLocalModel: () => m.model,
        api,
        createSource: source,
        hosted: engines(),
      },
      "req_r",
    );
    const j = (await res.json()) as {
      output: Array<Record<string, unknown>>;
    };
    assert.deepEqual(m.offered, [
      ["save_year", T],
      ["save_year", T],
    ]);
    assert.deepEqual(
      j.output.map((o) => o.type),
      ["web_search_call", "message", "function_call"],
    );
    assert.match(String(j.output[0].id), /^ws_/);
    assert.equal(j.output[0].status, "completed");
    const content = j.output[1].content as Array<{
      annotations: Array<{ type: string; url: string }>;
    }>;
    assert.equal(content[0].annotations[0].type, "url_citation");
    assert.equal(content[0].annotations[0].url, SECRET_URL);
    assert.equal(j.output[2].name, "save_year");
  });

  test("Responses stream emits web_search_call events", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new TextPart("done")],
    ]);
    const res = await handleResponses(
      new Request("http://x/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          input: "q",
          stream: true,
          tools: [{ type: "web_search_preview" }],
        }),
      }),
      {
        getLocalModel: () => m.model,
        api,
        createSource: source,
        hosted: engines(),
      },
      "req_s",
    );
    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((x) => x[1]);
    for (const e of [
      "response.web_search_call.in_progress",
      "response.web_search_call.searching",
      "response.web_search_call.completed",
    ]) {
      assert.ok(events.includes(e), e);
    }
    assert.equal(events[events.length - 1], "response.completed");
  });

  const gemDeps = (
    model: LmChatLike,
    hosted?: HostedEngines,
  ): ProtocolDeps => ({
    getLocalModel: () => model,
    maxSearchesPerRequest: 5,
    hosted,
  });
  const gemPost = (body: unknown) =>
    new Request("http://x/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      body: JSON.stringify(body),
    });

  test("googleSearch gives groundingMetadata on the final candidate", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new TextPart("It is 42 [1].")],
    ]);
    const res = await handleGemini(
      gemPost({
        contents: [{ role: "user", parts: [{ text: "q" }] }],
        tools: [{ googleSearch: {} }],
      }),
      gemDeps(m.model, engines()),
      "req_g",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      candidates: Array<{
        groundingMetadata?: {
          webSearchQueries: string[];
          groundingChunks: Array<{ web: { uri: string } }>;
        };
      }>;
    };
    const g = j.candidates[0].groundingMetadata!;
    assert.deepEqual(g.webSearchQueries, ["q"]);
    assert.equal(g.groundingChunks[0].web.uri, SECRET_URL);
  });

  test("Gemini search-only request without a provider is 400 FAILED_PRECONDITION", async () => {
    const m = scripted([[new TextPart("x")]]);
    const res = await handleGemini(
      gemPost({
        contents: [{ role: "user", parts: [{ text: "q" }] }],
        tools: [{ googleSearch: {} }],
      }),
      gemDeps(m.model),
      "req_g2",
      { api, createSource: source },
    );
    assert.equal(res.status, 400);
    const j = (await res.json()) as {
      error: { status: string; message: string };
    };
    assert.equal(j.error.status, "FAILED_PRECONDITION");
    assert.match(j.error.message, /Agent Gateway: Web Search and Fetch/);
    assert.equal(m.calls(), 0);
  });

  test("urlContext fetches pages before the model call and reports urlContextMetadata", async () => {
    const m = scripted([[new TextPart("summary")]]);
    const res = await handleGemini(
      gemPost({
        contents: [
          { role: "user", parts: [{ text: `summarise ${SECRET_URL}` }] },
        ],
        tools: [{ urlContext: {} }],
      }),
      gemDeps(m.model, engines()),
      "req_g3",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      candidates: Array<{
        urlContextMetadata?: {
          urlMetadata: Array<{
            retrievedUrl: string;
            urlRetrievalStatus: string;
          }>;
        };
      }>;
    };
    assert.equal(m.calls(), 1);
    const text = (
      j as unknown as {
        candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
      }
    ).candidates[0].content.parts
      .map((p) => p.text ?? "")
      .join("");
    assert.equal(text, `summary\n\nSources:\n[1] Page - ${SECRET_URL}`);
    assert.deepEqual(j.candidates[0].urlContextMetadata!.urlMetadata, [
      {
        retrievedUrl: SECRET_URL,
        urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
      },
    ]);
  });

  test("urlContext with no engine returns ERROR statuses and makes no model call", async () => {
    const m = scripted([[new TextPart("x")]]);
    const res = await handleGemini(
      gemPost({
        contents: [{ role: "user", parts: [{ text: `read ${SECRET_URL}` }] }],
        tools: [{ urlContext: {} }],
      }),
      gemDeps(m.model),
      "req_g4",
      { api, createSource: source },
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as {
      candidates: Array<{
        urlContextMetadata: {
          urlMetadata: Array<{ urlRetrievalStatus: string }>;
        };
      }>;
    };
    assert.equal(m.calls(), 0);
    assert.equal(
      j.candidates[0].urlContextMetadata.urlMetadata[0].urlRetrievalStatus,
      "URL_RETRIEVAL_STATUS_ERROR",
    );
  });
});

suite("protocol/hosted Sources list", () => {
  const LIST = `\n\nSources:\n[1] Secret - ${SECRET_URL}`;
  const twoRounds = () =>
    scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new TextPart("It is 42 [1].")],
    ]);
  const messages = (stream: boolean) =>
    anthropicPost({
      model: "m",
      max_tokens: 100,
      stream,
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });

  test("Anthropic: appended to the final text block; citations unchanged", async () => {
    const m = twoRounds();
    const res = await handleAnthropic(
      messages(false),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: engines() },
      "req_src_a",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      content: Array<{ type: string; text?: string; citations?: unknown[] }>;
    };
    const last = j.content.at(-1)!;
    assert.equal(last.type, "text");
    assert.equal(last.text, `It is 42 [1].${LIST}`);
    assert.equal(last.citations?.length, 1);
  });

  test("Anthropic stream: Sources arrive as a text_delta before message_stop", async () => {
    const m = twoRounds();
    const res = await handleAnthropic(
      messages(true),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: engines() },
      "req_src_as",
      { api, createSource: source },
    );
    const text = await res.text();
    const datas = [...text.matchAll(/^data: (.+)$/gm)].map(
      (x) => JSON.parse(x[1]) as Record<string, unknown>,
    );
    const deltas = datas
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta as { type: string; text?: string });
    assert.ok(deltas.some((d) => d.type === "text_delta" && d.text === LIST));
    assert.equal(deltas.filter((d) => d.type === "citations_delta").length, 1);
    assert.equal(datas.at(-1)!.type, "message_stop");
  });

  test("Anthropic: Sources text block comes before the client tool_use", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new TextPart("ok"), new ToolCallPart("c2", "save_year", { year: 1 })],
    ]);
    const res = await handleAnthropic(
      anthropicPost({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "q" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }, saveYear],
      }),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: engines() },
      "req_src_at",
      { api, createSource: source },
    );
    const j = (await res.json()) as {
      stop_reason: string;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(j.stop_reason, "tool_use");
    assert.deepEqual(
      j.content.map((b) => b.type),
      ["server_tool_use", "web_search_tool_result", "text", "tool_use"],
    );
    assert.equal(j.content[2].text, `ok${LIST}`);
  });

  test("Responses: Sources message comes before the function_call item", async () => {
    const m = scripted([
      [new ToolCallPart("c1", T, { query: "q" })],
      [new ToolCallPart("call_2", "save_year", { year: 1 })],
    ]);
    const res = await handleResponses(
      new Request("http://x/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          input: "q",
          tools: [
            { type: "web_search" },
            {
              type: "function",
              name: "save_year",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      }),
      {
        getLocalModel: () => m.model,
        api,
        createSource: source,
        hosted: engines(),
      },
      "req_src_rt",
    );
    const j = (await res.json()) as {
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    assert.deepEqual(
      j.output.map((o) => o.type),
      ["web_search_call", "message", "function_call"],
    );
    assert.equal(j.output[1].content![0].text, LIST);
  });

  test("Anthropic: nothing appended when no search ran", async () => {
    const m = scripted([[new TextPart("hi")]]);
    const res = await handleAnthropic(
      messages(false),
      { endpoint: "messages" },
      { getLocalModel: () => m.model, hosted: engines() },
      "req_src_an",
      { api, createSource: source },
    );
    assert.ok(!(await res.text()).includes("Sources:"));
  });

  const responsesPost = (stream: boolean) =>
    new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        input: "q",
        stream,
        tools: [{ type: "web_search" }],
      }),
    });

  test("Responses: appended to output_text; url_citation only for the answer", async () => {
    const m = twoRounds();
    const res = await handleResponses(
      responsesPost(false),
      {
        getLocalModel: () => m.model,
        api,
        createSource: source,
        hosted: engines(),
      },
      "req_src_r",
    );
    const j = (await res.json()) as {
      output: Array<{
        type: string;
        content?: Array<{ text: string; annotations: unknown[] }>;
      }>;
    };
    const msg = j.output.find((o) => o.type === "message")!;
    assert.equal(msg.content![0].text, `It is 42 [1].${LIST}`);
    assert.equal(msg.content![0].annotations.length, 1);
  });

  test("Responses stream: Sources arrive as an output_text delta", async () => {
    const m = twoRounds();
    const res = await handleResponses(
      responsesPost(true),
      {
        getLocalModel: () => m.model,
        api,
        createSource: source,
        hosted: engines(),
      },
      "req_src_rs",
    );
    const text = await res.text();
    const datas = [...text.matchAll(/^data: (.+)$/gm)].map(
      (x) => JSON.parse(x[1]) as Record<string, unknown>,
    );
    assert.ok(
      datas.some(
        (d) => d.type === "response.output_text.delta" && d.delta === LIST,
      ),
    );
    const done = datas.find((d) => d.type === "response.output_text.done")!;
    assert.equal(done.text, `It is 42 [1].${LIST}`);
  });

  const gemPost = (stream: boolean) =>
    new Request(
      `http://x/v1beta/models/gemini-2.5-pro:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
      {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "q" }] }],
          tools: [{ googleSearch: {} }],
        }),
      },
    );
  const gemDeps = (model: LmChatLike): ProtocolDeps => ({
    getLocalModel: () => model,
    maxSearchesPerRequest: 5,
    hosted: engines(),
  });

  test("Gemini: Sources appended as text; grounding supports cover the answer only", async () => {
    const m = twoRounds();
    const res = await handleGemini(
      gemPost(false),
      gemDeps(m.model),
      "req_src_g",
      {
        api,
        createSource: source,
      },
    );
    const j = (await res.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> };
        groundingMetadata?: { groundingSupports: unknown[] };
      }>;
    };
    const c = j.candidates[0];
    const text = c.content.parts.map((p) => p.text ?? "").join("");
    assert.equal(text, `It is 42 [1].${LIST}`);
    assert.equal(c.groundingMetadata!.groundingSupports.length, 1);
  });

  test("Gemini stream: Sources arrive as a text part", async () => {
    const m = twoRounds();
    const res = await handleGemini(
      gemPost(true),
      gemDeps(m.model),
      "req_src_gs",
      {
        api,
        createSource: source,
      },
    );
    const body = await res.text();
    const parts = [...body.matchAll(/^data: (.+)$/gm)].flatMap(
      (x) =>
        (
          JSON.parse(x[1]) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
          }
        ).candidates?.[0]?.content?.parts ?? [],
    );
    assert.ok(parts.some((p) => p.text === LIST));
  });
});
