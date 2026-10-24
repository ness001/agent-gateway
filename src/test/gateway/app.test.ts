import * as assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { type GatewayAppDeps, createGatewayApp } from "../../gateway/app";
import { buildRegistry } from "../../gateway/catalog";
import { ALL_OPERATIONS, type ModelInfo } from "../../gateway/types";

const model = (id: string): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 200000,
  inputModalities: ["text"],
  supportsToolCalling: true,
  defaultReasoningLevel: "medium",
  supportedReasoningLevels: [{ effort: "medium", description: "Medium" }],
  operations: [...ALL_OPERATIONS],
});

interface Harness {
  deps: GatewayAppDeps;
  local: Request[];
  remote: { url: string; headers: Headers; body: string | undefined }[];
  logs: string[];
}

function harness(apiKey?: string): Harness {
  const local: Request[] = [];
  const remote: Harness["remote"] = [];
  const logs: string[] = [];
  const localModels = [
    model("claude-sonnet-4.5"),
    model("gpt-5"),
    model("gpt-6-astra"),
  ];
  const registry = buildRegistry(localModels, [
    { name: "box", models: [model("gpt-5-remote")] },
  ]);
  const deps: GatewayAppDeps = {
    getRegistry: () => registry,
    getLocalModels: () => localModels,
    handleLocal: async (req) => {
      local.push(req);
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
    getRemote: (name) =>
      name === "box" ? { name, url: "http://remote.test" } : undefined,
    getRemoteApiKey: async () => "remote-secret",
    getApiKey: async () => apiKey,
    getHealth: () => ({ status: "Ready" }),
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      debug: (m) => logs.push(m),
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      remote.push({
        url,
        headers: new Headers(init.headers),
        body: init.body as string | undefined,
      });
      return new Response('{"remote":true}', { status: 200 });
    }) as typeof fetch,
  };
  return { deps, local, remote, logs };
}

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  new Request(`http://127.0.0.1:24444${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: HeadersInit = {}) =>
  new Request(`http://127.0.0.1:24444${path}`, { headers });

suite("Gateway app", () => {
  test("GET /v1/models returns ordinary and Codex shapes", async () => {
    const app = createGatewayApp(harness().deps);
    const plain = await (await app.fetch(get("/v1/models"))).json();
    assert.strictEqual(plain.has_more, false);
    const ids = plain.data.map((m: { id: string }) => m.id);
    assert.ok(ids.includes("gpt-5"));
    assert.ok(ids.includes("box--gpt-5-remote"));
    const codex = await (
      await app.fetch(get("/v1/models?client_version=0.1"))
    ).json();
    assert.ok(Array.isArray(codex.models));
  });

  test("catalog lists local models only", async () => {
    const app = createGatewayApp(harness().deps);
    const body = await (await app.fetch(get("/v1/gateway/catalog"))).json();
    assert.strictEqual(body.version, 1);
    assert.deepStrictEqual(
      body.models.map((m: { id: string }) => m.id).sort(),
      ["claude-sonnet-4.5", "gpt-5", "gpt-6-astra"],
    );
  });

  test("apiKey is enforced on every route", async () => {
    const app = createGatewayApp(harness("s3cret").deps);
    for (const path of ["/health", "/v1/models", "/v1/gateway/catalog"]) {
      assert.strictEqual((await app.fetch(get(path))).status, 401, path);
    }
    const anth = await app.fetch(post("/v1/messages", { model: "gpt-5" }));
    assert.strictEqual(anth.status, 401);
    assert.strictEqual((await anth.json()).type, "error");
    const gem = await app.fetch(
      post("/v1beta/models/gpt-5:generateContent", {}),
    );
    assert.strictEqual((await gem.json()).error.status, "UNAUTHENTICATED");
    const ok = await app.fetch(
      get("/health", { authorization: "Bearer s3cret" }),
    );
    assert.strictEqual(ok.status, 200);
  });

  test("caller credentials never reach local handlers or remotes", async () => {
    const h = harness("s3cret");
    const app = createGatewayApp(h.deps);
    await app.fetch(
      post(
        "/v1/messages",
        { model: "claude-sonnet-4.5" },
        { "x-api-key": "s3cret", cookie: "c=1" },
      ),
    );
    await app.fetch(
      post(
        "/v1beta/models/claude-sonnet-4.5:generateContent?key=s3cret&alt=sse",
        {},
      ),
    );
    await app.fetch(
      post(
        "/v1/responses",
        { model: "box--gpt-5-remote" },
        { authorization: "Bearer s3cret" },
      ),
    );
    assert.strictEqual(h.local.length, 2);
    for (const req of h.local) {
      assert.strictEqual(req.headers.get("x-api-key"), null);
      assert.strictEqual(req.headers.get("cookie"), null);
      assert.ok(!req.url.includes("s3cret"));
    }
    assert.ok(h.local[1].url.endsWith("?alt=sse"));
    assert.strictEqual(h.remote.length, 1);
    assert.strictEqual(
      h.remote[0].headers.get("authorization"),
      "Bearer remote-secret",
    );
    assert.ok(!h.logs.join("\n").includes("s3cret"));
  });

  test("remote entries are forwarded with the upstream model ID", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    const res = await app.fetch(
      post("/v1/chat/completions", { model: "box--gpt-5-remote" }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.local.length, 0);
    assert.strictEqual(
      h.remote[0].url,
      "http://remote.test/v1/chat/completions",
    );
    assert.strictEqual(JSON.parse(h.remote[0].body!).model, "gpt-5-remote");
  });

  test("remote settings cover all inference protocols without changing passthrough", async () => {
    const cases = [
      {
        path: "/v1/messages",
        protocol: "anthropic",
        body: {
          max_tokens: 4096,
          top_p: 0.8,
          stop_sequences: ["SECRET STOP"],
          output_config: { effort: "high" },
          tools: [
            { name: "SECRET TOOL", input_schema: {} },
            { type: "web_search_20250305" },
          ],
          tool_choice: {
            type: "tool",
            name: "SECRET TOOL",
            disable_parallel_tool_use: true,
          },
        },
        expected: [
          "max_tokens=4096",
          "top_p=0.8",
          "stop=1",
          "reasoning=high",
          "tools=1",
          "tool_choice=required",
          "hosted=web_search_20250305",
          "parallel_tool_calls=false",
        ],
      },
      {
        path: "/v1/chat/completions",
        protocol: "openai-chat",
        body: {
          max_completion_tokens: 2048,
          stop: "SECRET STOP",
          reasoning_effort: "medium",
          tools: [{ type: "function", function: { name: "SECRET TOOL" } }],
          tool_choice: { type: "function", function: { name: "SECRET TOOL" } },
          parallel_tool_calls: true,
          prompt_cache_key: "SECRET CACHE",
        },
        expected: [
          "max_tokens=2048",
          "stop=1",
          "reasoning=medium",
          "tools=1",
          "tool_choice=required",
          "parallel_tool_calls=true",
          "cache_key=yes",
        ],
      },
      {
        path: "/v1/responses",
        protocol: "openai-responses",
        body: {
          max_output_tokens: 1024,
          reasoning: { effort: "low" },
          tools: [{ type: "web_search_preview" }],
          tool_choice: "required",
          prompt_cache_key: "SECRET CACHE",
        },
        expected: [
          "max_tokens=1024",
          "reasoning=low",
          "tools=0",
          "tool_choice=required",
          "hosted=web_search_preview",
          "cache_key=yes",
        ],
      },
      {
        path: "/v1beta/models/box--gpt-5-remote:streamGenerateContent",
        protocol: "gemini",
        body: {
          generationConfig: {
            maxOutputTokens: 512,
            topP: 0.9,
            temperature: 0.2,
            stopSequences: ["SECRET STOP"],
            thinkingConfig: { thinkingLevel: "HIGH" },
          },
          tools: [
            { functionDeclarations: [{ name: "SECRET TOOL" }] },
            { googleSearch: {} },
            { urlContext: {} },
          ],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
          cachedContent: "SECRET CACHE",
          stream: false,
        },
        expected: [
          "max_tokens=512",
          "top_p=0.9",
          "temperature=0.2",
          "stop=1",
          "reasoning=high",
          "tools=1",
          "tool_choice=required",
          "hosted=googleSearch,urlContext",
          "cache_key=yes",
        ],
      },
    ];
    for (const c of cases) {
      const h = harness();
      const body = {
        model: "box--gpt-5-remote",
        temperature: 0.4,
        stream: true,
        messages: [{ role: "user", content: "SECRET PROMPT" }],
        future_extension: { type: "SECRET UNKNOWN", arguments: "SECRET ARGS" },
        ...c.body,
      };
      const res = await createGatewayApp(h.deps).fetch(
        post(c.path, body, { authorization: "Bearer SECRET KEY" }),
      );
      assert.strictEqual(res.status, 200, c.protocol);
      assert.deepStrictEqual(
        JSON.parse(h.remote[0].body!),
        c.protocol === "gemini" ? body : { ...body, model: "gpt-5-remote" },
      );
      const lines = h.logs.filter((line) => line.includes(" settings "));
      assert.strictEqual(lines.length, 1, c.protocol);
      const line = lines[0];
      for (const field of [
        `${c.protocol} settings`,
        'model="box--gpt-5-remote"',
        'resolved="gpt-5-remote"',
        "[remote][box]",
        "forwarded=true",
        "stream=true",
        ...c.expected,
      ]) {
        assert.ok(line.includes(field), `${field}: ${line}`);
      }
      assert.ok(!line.includes("ignored"));
      assert.ok(!h.logs.join("\n").includes("SECRET"));
      assert.ok(
        h.logs.some(
          (line) =>
            line.startsWith("[remote][box] ") && line.includes("status=200"),
        ),
      );
    }
  });

  test("remote summaries identify failed routes and upstream errors", async () => {
    for (const mode of ["missing", "unsupported", "http", "network"]) {
      const h = harness();
      if (mode === "missing") {
        h.deps.getRemote = () => undefined;
      } else if (mode === "unsupported") {
        const entries = h.deps
          .getRegistry()
          .map((entry) => ({ ...entry, operations: [] }));
        h.deps.getRegistry = () => entries;
      } else {
        h.deps.fetchImpl = (async () => {
          if (mode === "network") {
            throw new TypeError("SECRET NETWORK");
          }
          return new Response("SECRET UPSTREAM", { status: 429 });
        }) as typeof fetch;
      }
      const res = await createGatewayApp(h.deps).fetch(
        post("/v1/responses", { model: "box--gpt-5-remote" }),
      );
      assert.ok(res.status >= 400, mode);
      assert.ok(
        h.logs.some(
          (line) =>
            line.startsWith("[remote][box] ") &&
            line.includes(`status=${res.status}`),
        ),
        h.logs.join("\n"),
      );
      assert.ok(!h.logs.join("\n").includes("SECRET"));
    }
  });

  test("remote metadata skips token counting and uses Gemini action for streaming", async () => {
    for (const path of [
      "/v1/messages/count_tokens",
      "/v1beta/models/box--gpt-5-remote:countTokens",
      "/v1beta/models/box--gpt-5-remote:generateContent",
    ]) {
      const h = harness();
      const res = await createGatewayApp(h.deps).fetch(
        post(path, { model: "box--gpt-5-remote", stream: true }),
      );
      assert.strictEqual(res.status, 200);
      const lines = h.logs.filter((line) => line.includes(" settings "));
      if (path.endsWith("generateContent")) {
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes("stream=false"));
      } else {
        assert.strictEqual(lines.length, 0);
      }
    }
  });

  test("a settings logger failure cannot reject remote forwarding", async () => {
    const h = harness();
    h.deps.logger.info = (line) => {
      if (line.includes(" settings ")) {
        throw new Error("logger unavailable");
      }
    };
    const res = await createGatewayApp(h.deps).fetch(
      post("/v1/responses", {
        model: "box--gpt-5-remote",
        tools: "future shape",
        reasoning: false,
      }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.remote.length, 1);
  });

  test("aliases rewrite to the local upstream ID", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    await app.fetch(
      post("/v1/messages", { model: "gateway-claude-claude-sonnet-4.5" }),
    );
    assert.strictEqual((await h.local[0].json()).model, "claude-sonnet-4.5");
  });

  test("unknown model errors follow each protocol", async () => {
    const app = createGatewayApp(harness().deps);
    const openai = await app.fetch(post("/v1/responses", { model: "nope" }));
    assert.strictEqual(openai.status, 400);
    assert.strictEqual(
      (await openai.json()).error.type,
      "invalid_request_error",
    );
    const anth = await app.fetch(post("/v1/messages", { model: "nope" }));
    assert.strictEqual(anth.status, 400);
    assert.strictEqual((await anth.json()).type, "error");
    const gem = await app.fetch(post("/v1beta/models/nope:countTokens", {}));
    assert.strictEqual(gem.status, 404);
    assert.strictEqual((await gem.json()).error.status, "NOT_FOUND");
    const bad = await app.fetch(post("/v1beta/models/a%2Fb:countTokens", {}));
    assert.strictEqual(bad.status, 400);
  });

  test("Gemini never falls back; other protocols use the configured fallback", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    const app = createGatewayApp(h.deps);
    const gem = await app.fetch(
      post("/v1beta/models/unknown-model:generateContent", {}),
    );
    assert.strictEqual(gem.status, 404);
    const res = await app.fetch(
      post("/v1/messages", { model: "unknown-model" }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.local.length, 1);
    const used = (await h.local[0].json()).model;
    assert.strictEqual(used, "gpt-6-astra");
    assert.ok(
      h.logs.some((l) =>
        /^\[[^\]]+\] Model fallback: requested "unknown-model" -> using "gpt-6-astra" \(reason: unknown model\)$/.test(
          l,
        ),
      ),
    );
    assert.strictEqual(
      res.headers.get("x-agent-gateway-model-fallback"),
      "unknown-model -> gpt-6-astra; reason=unknown model",
    );
    assert.strictEqual(res.headers.get("x-agent-gateway-model"), "gpt-6-astra");
  });

  test("agentGateway.fallbackModel picks the fallback; a missing one warns once", async () => {
    const h = harness();
    let setting = "gpt-5";
    h.deps.getFallbackModel = () => setting;
    const app = createGatewayApp(h.deps);
    const res = await app.fetch(
      post("/v1/messages", { model: "unknown-model" }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await h.local[0].json()).model, "gpt-5");
    assert.strictEqual(
      res.headers.get("x-agent-gateway-model-fallback"),
      "unknown-model -> gpt-5; reason=unknown model",
    );
    assert.ok(
      h.logs.some((l) =>
        /Model fallback: requested "unknown-model" -> using "gpt-5"/.test(l),
      ),
    );
    const gem = await app.fetch(
      post("/v1beta/models/unknown-model:generateContent", {}),
    );
    assert.strictEqual(gem.status, 404);

    setting = "missing-model";
    for (let i = 0; i < 2; i++) {
      const r = await app.fetch(post("/v1/messages", { model: "other" }));
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.headers.get("x-agent-gateway-model-fallback"), null);
    }
    assert.strictEqual(h.local.length, 1);
    assert.strictEqual(
      h.logs.filter((l) => l.includes('fallbackModel "missing-model"')).length,
      1,
    );

    setting = "box--gpt-5-remote";
    const remote = await app.fetch(post("/v1/messages", { model: "x" }));
    assert.strictEqual(remote.status, 200);
    assert.strictEqual(h.remote.length, 1);
    assert.strictEqual(h.local.length, 1);
    assert.strictEqual(JSON.parse(h.remote[0].body!).model, "gpt-5-remote");
    assert.strictEqual(
      remote.headers.get("x-agent-gateway-model-fallback"),
      "x -> box--gpt-5-remote; reason=unknown model",
    );
  });

  test("clearing fallback disables unknown-model and built-in Gemini alias routing", async () => {
    const h = harness();
    let setting = "gpt-5";
    h.deps.getFallbackModel = () => setting;
    const app = createGatewayApp(h.deps);
    for (const path of [
      "/v1/messages",
      "/v1beta/models/gemini-3-flash-preview:generateContent",
    ]) {
      setting = "gpt-5";
      assert.strictEqual(
        (await app.fetch(post(path, { model: "unknown-model" }))).status,
        200,
      );
      setting = "";
      const res = await app.fetch(post(path, { model: "unknown-model" }));
      assert.strictEqual(res.status, path === "/v1/messages" ? 400 : 404);
      assert.strictEqual(
        res.headers.get("x-agent-gateway-model-fallback"),
        null,
      );
    }
    assert.strictEqual(h.local.length, 2);
  });

  test("an incompatible configured fallback does not use available Astra", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "box--limited";
    h.deps.getRegistry = () =>
      buildRegistry(
        [model("gpt-6-astra")],
        [
          {
            name: "box",
            models: [{ ...model("limited"), operations: ["openai.responses"] }],
          },
        ],
      );
    const app = createGatewayApp(h.deps);
    const res = await app.fetch(post("/v1/messages", { model: "unknown" }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(h.local.length, 0);
    assert.strictEqual(h.remote.length, 0);
    assert.ok(h.logs.some((l) => l.includes("no fallback will be used")));
  });

  test("built-in Gemini aliases can use an explicitly configured remote fallback", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "box--gpt-5-remote";
    const res = await createGatewayApp(h.deps).fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", {
        contents: [],
      }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.local.length, 0);
    assert.strictEqual(h.remote.length, 1);
    assert.strictEqual(
      h.remote[0].url,
      "http://remote.test/v1beta/models/gpt-5-remote:generateContent",
    );
    assert.strictEqual(
      res.headers.get("x-agent-gateway-model-fallback"),
      "gemini-3-flash-preview -> box--gpt-5-remote; reason=model alias",
    );
  });

  test("Gemini CLI internal model names use the configured fallback without a local Gemini model", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    const app = createGatewayApp(h.deps);
    const searchBody = {
      contents: [{ role: "user", parts: [{ text: "latest news" }] }],
      tools: [{ googleSearch: {} }],
    };
    const res = await app.fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", searchBody),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.local.length, 1);
    assert.match(
      new URL(h.local[0].url).pathname,
      /\/v1beta\/models\/gpt-6-astra:generateContent$/,
    );
    assert.deepStrictEqual(await h.local[0].json(), searchBody);
    assert.strictEqual(
      res.headers.get("x-agent-gateway-model-fallback"),
      "gemini-3-flash-preview -> gpt-6-astra; reason=model alias",
    );
    assert.ok(
      h.logs.some((l) =>
        /^\[[^\]]+\] Model fallback: requested "gemini-3-flash-preview" -> using "gpt-6-astra" \(reason: model alias\)$/.test(
          l,
        ),
      ),
    );

    const retrieval = await app.fetch(
      post("/v1beta/models/gemini-3-flash-preview:streamGenerateContent", {
        contents: [],
        tools: [{ googleSearchRetrieval: {} }],
      }),
    );
    assert.strictEqual(retrieval.status, 200);
  });

  test("Gemini hosted-search model prefers the configured model, then a Gemini-family model", async () => {
    const h = harness();
    const gemini = { ...model("gemini-2.5-pro"), family: "gemini-2.5-pro" };
    const registry = buildRegistry(
      [model("gpt-5"), model("gpt-6-astra"), gemini],
      [],
    );
    h.deps.getRegistry = () => registry;
    const body = { contents: [], tools: [{ googleSearch: {} }] };
    const app = createGatewayApp(h.deps);
    const auto = await app.fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", body),
    );
    assert.match(
      auto.headers.get("x-agent-gateway-model-fallback") ?? "",
      /-> gemini-2\.5-pro;/,
    );

    h.deps.getWebSearchModel = () => "gpt-5";
    const configured = await createGatewayApp(h.deps).fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", body),
    );
    assert.match(
      configured.headers.get("x-agent-gateway-model-fallback") ?? "",
      /-> gpt-5;/,
    );
  });

  test("Gemini keeps no-fallback for unknown models with function declarations", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    for (const tools of [
      [{ functionDeclarations: [{ name: "google_web_search" }] }],
      [{ googleSearch: {} }, { functionDeclarations: [{ name: "x" }] }],
      [{ googleSearch: {}, functionDeclarations: [{ name: "x" }] }],
    ]) {
      const res = await app.fetch(
        post("/v1beta/models/gemini-9-ultra:generateContent", {
          contents: [],
          tools,
        }),
      );
      assert.strictEqual(res.status, 404);
    }
    const count = await app.fetch(
      post("/v1beta/models/gemini-9-ultra:countTokens", {
        tools: [{ googleSearch: {} }],
      }),
    );
    assert.strictEqual(count.status, 404);
    assert.strictEqual(h.local.length, 0);
  });

  test("model aliases: Gemini CLI names pick the best local Gemini model of the tier", async () => {
    const h = harness();
    const gem = (id: string) => ({ ...model(id), family: id });
    const registry = buildRegistry(
      [
        model("gpt-6-astra"),
        gem("gemini-2.5-pro"),
        gem("gemini-3.1-pro-preview"),
        gem("gemini-3-flash"),
        gem("gemini-2.0-flash"),
      ],
      [],
    );
    h.deps.getRegistry = () => registry;
    const app = createGatewayApp(h.deps);
    const body = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0, topP: 1 },
    };
    for (const [requested, expected] of [
      ["gemini-3-flash-preview", "gemini-3-flash"],
      ["gemini-2.5-flash-lite", "gemini-3-flash"],
      ["gemini-3.1-flash-lite-preview", "gemini-3-flash"],
      ["gemini-2.5-flash", "gemini-3-flash"],
      ["gemini-3-pro-preview", "gemini-3.1-pro-preview"],
    ]) {
      const res = await app.fetch(
        post(`/v1beta/models/${requested}:generateContent`, body),
      );
      assert.strictEqual(res.status, 200, requested);
      assert.strictEqual(
        res.headers.get("x-agent-gateway-model-fallback"),
        `${requested} -> ${expected}; reason=model alias`,
      );
    }
    // A local model with the requested name is used directly.
    const direct = await app.fetch(
      post("/v1beta/models/gemini-2.5-pro:generateContent", body),
    );
    assert.strictEqual(
      direct.headers.get("x-agent-gateway-model-fallback"),
      null,
    );
    // Aliased names are not advertised.
    const models = (await (await app.fetch(get("/v1/models"))).json()) as {
      data: { id: string }[];
    };
    assert.ok(!models.data.some((m) => m.id === "gemini-3-flash-preview"));
  });

  test("model aliases: user override, disable and other protocols", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    h.deps.getModelAliases = () => ({
      "gemini-3-flash-preview": "gpt-5",
      "gemini-2.5-flash": "",
      "my-model": "claude-sonnet-4.5",
      "broken-alias": "does-not-exist",
    });
    const app = createGatewayApp(h.deps);
    const user = await app.fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", {
        contents: [],
        tools: [{ urlContext: {} }],
      }),
    );
    assert.strictEqual(
      user.headers.get("x-agent-gateway-model-fallback"),
      "gemini-3-flash-preview -> gpt-5; reason=model alias",
    );
    const disabled = await app.fetch(
      post("/v1beta/models/gemini-2.5-flash:generateContent", { contents: [] }),
    );
    assert.strictEqual(disabled.status, 404);
    const anthropic = await app.fetch(
      post("/v1/messages", { model: "my-model", messages: [] }),
    );
    assert.strictEqual(
      anthropic.headers.get("x-agent-gateway-model-fallback"),
      "my-model -> claude-sonnet-4.5; reason=model alias",
    );
    assert.strictEqual(
      (await h.local.at(-1)!.json()).model,
      "claude-sonnet-4.5",
    );
    // A broken user alias falls through to the normal unknown-model rules.
    const broken = await app.fetch(
      post("/v1/messages", { model: "broken-alias", messages: [] }),
    );
    assert.match(
      broken.headers.get("x-agent-gateway-model-fallback") ?? "",
      /reason=unknown model/,
    );
    assert.ok(
      h.logs.some((l) =>
        /^\[[^\]]+\] Model fallback: requested "my-model" -> using "claude-sonnet-4.5" \(reason: model alias\)$/.test(
          l,
        ),
      ),
    );
  });

  test("the exact Gemini CLI web-fetch request resolves through the alias", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    const app = createGatewayApp(h.deps);
    // Shape sent by Gemini CLI 0.32.1 web_fetch (model config 'web-fetch').
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Summarize https://example.com/page" }],
        },
      ],
      generationConfig: { temperature: 0, topP: 1 },
      tools: [{ urlContext: {} }],
    };
    const res = await app.fetch(
      post("/v1beta/models/gemini-3-flash-preview:generateContent", body),
    );
    assert.strictEqual(res.status, 200);
    assert.match(
      new URL(h.local[0].url).pathname,
      /\/v1beta\/models\/gpt-6-astra:generateContent$/,
    );
    assert.deepStrictEqual(await h.local[0].json(), body);
  });

  test("404 and 405 handling", async () => {
    const app = createGatewayApp(harness().deps);
    const missing = await app.fetch(get("/v2/whatever"));
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(
      (await missing.json()).error.type,
      "invalid_request_error",
    );
    const wrong = await app.fetch(get("/v1/messages/count_tokens"));
    assert.strictEqual(wrong.status, 405);
    assert.strictEqual(wrong.headers.get("allow"), "POST");
    const gem = await app.fetch(get("/v1beta/models/gpt-5:generateContent"));
    assert.strictEqual(gem.status, 405);
    const postModels = await app.fetch(post("/v1/models", {}));
    assert.strictEqual(postModels.status, 405);
    assert.strictEqual(postModels.headers.get("allow"), "GET");
    const geminiOther = await app.fetch(post("/v1beta/files", {}));
    assert.strictEqual(geminiOther.status, 404);
  });

  test("request log has id, route, model, status and no body", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    await app.fetch(
      post("/v1/messages", { model: "gpt-5", messages: ["PRIVATE"] }),
    );
    const line = h.logs.find((l) => l.includes("/v1/messages"))!;
    assert.match(
      line,
      /anthropic POST \/v1\/messages model="gpt-5" status=200 \d+ms/,
    );
    assert.ok(!h.logs.join("\n").includes("PRIVATE"));
  });

  test("tunnel warning is logged once when no apiKey is set", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    await app.fetch(get("/health", { "x-forwarded-for": "1.2.3.4" }));
    await app.fetch(get("/health", { "x-forwarded-for": "1.2.3.4" }));
    assert.strictEqual(
      h.logs.filter((l) => l.includes("forwarding proxy")).length,
      1,
    );
  });

  test("operation not advertised by the model returns 400", async () => {
    const h = harness();
    const limited = { ...model("gpt-5"), operations: ["openai.responses"] };
    h.deps.getRegistry = () => buildRegistry([limited as ModelInfo], []);
    const app = createGatewayApp(h.deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(h.local.length, 0);
    const ok = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" }),
    });
    assert.strictEqual(ok.status, 200);
  });
  test("model header on local and remote responses, no fallback header", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    const loc = await app.fetch(post("/v1/messages", { model: "gpt-5" }));
    assert.strictEqual(loc.headers.get("x-agent-gateway-model"), "gpt-5");
    assert.strictEqual(loc.headers.get("x-agent-gateway-model-fallback"), null);
    const rem = await app.fetch(
      post("/v1/messages", { model: "box--gpt-5-remote" }),
    );
    assert.strictEqual(rem.status, 200);
    assert.strictEqual(
      rem.headers.get("x-agent-gateway-model"),
      "gpt-5-remote",
    );
  });

  test("fallback reasons for remote-prefixed IDs are logged and in headers", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    h.deps.getRemoteStates = () => [
      {
        name: "box",
        url: "http://remote.test",
        status: "ready",
        modelCount: 1,
      },
      { name: "self", url: "http://x", status: "skipped", reason: "loop" },
    ];
    const app = createGatewayApp(h.deps);
    const a = await app.fetch(
      post("/v1/responses", { model: "box--claude-haiku-5.5" }),
    );
    assert.strictEqual(a.status, 200);
    assert.strictEqual(
      a.headers.get("x-agent-gateway-model-fallback"),
      "box--claude-haiku-5.5 -> gpt-6-astra; reason=remote 'box' does not advertise model 'claude-haiku-5.5'",
    );
    const b = await app.fetch(post("/v1/responses", { model: "self--x" }));
    assert.match(
      b.headers.get("x-agent-gateway-model-fallback") ?? "",
      /reason=remote 'self' is unavailable \(loop\)$/,
    );
    assert.ok(
      h.logs.some((l) =>
        l.includes("(reason: remote 'self' is unavailable (loop))"),
      ),
    );
    assert.strictEqual(h.remote.length, 0);
  });

  test("fallback header strips CR/LF and non-ASCII from the requested ID", async () => {
    const h = harness();
    h.deps.getFallbackModel = () => "gpt-6-astra";
    const app = createGatewayApp(h.deps);
    const res = await app.fetch(
      post("/v1/messages", { model: "evil\r\nSet-Cookie: a=bé" }),
    );
    assert.strictEqual(res.status, 200);
    const v = res.headers.get("x-agent-gateway-model-fallback") ?? "";
    assert.ok(!/[\r\n]/.test(v) && /^[\x20-\x7e]*$/.test(v));
    assert.strictEqual(res.headers.get("set-cookie"), null);
    assert.ok(
      h.logs.some((l) => l.includes('requested "evil\\r\\nSet-Cookie')),
    );
  });

  test("unknown-model errors name the ID, reason and /v1/models", async () => {
    const h = harness();
    h.deps.getRegistry = () => buildRegistry([model("gpt-5")], []);
    h.deps.getRemoteStates = () => [
      { name: "box", url: "u", status: "skipped", reason: "HTTP 401" },
    ];
    const app = createGatewayApp(h.deps);
    const o = await app.fetch(post("/v1/responses", { model: "nope" }));
    assert.strictEqual(
      (await o.json()).error.message,
      'Unknown model "nope": unknown model. Use GET /v1/models to list available models.',
    );
    const a = await app.fetch(post("/v1/messages", { model: "box--m" }));
    assert.strictEqual(a.status, 400);
    assert.match(
      (await a.json()).error.message,
      /"box--m": remote 'box' is unavailable \(HTTP 401\)\. Use GET \/v1\/models/,
    );
    const g = await app.fetch(post("/v1beta/models/box--m:countTokens", {}));
    assert.strictEqual(g.status, 404);
    const gj = await g.json();
    assert.strictEqual(gj.error.status, "NOT_FOUND");
    assert.match(gj.error.message, /remote 'box' is unavailable/);
    const g2 = await app.fetch(post("/v1beta/models/zzz:countTokens", {}));
    assert.match(
      (await g2.json()).error.message,
      /"zzz": unknown model\. Use GET \/v1\/models/,
    );
  });

  for (const [code, status, category] of [
    ["ECONNREFUSED", 502, "connection refused"],
    ["ENOTFOUND", 502, "DNS lookup failed"],
    ["CERT_HAS_EXPIRED", 502, "TLS error"],
    ["UND_ERR_CONNECT_TIMEOUT", 504, "timeout"],
  ] as const) {
    test(`remote ${code} returns ${status} in each protocol envelope`, async () => {
      const h = harness();
      // A valid correlation ID may contain "tok"; it is not the error secret.
      const headers = { "x-request-id": "req_tok_remote_failure" };
      const sensitiveDetail = "private-upstream-detail/api-key=fixture-secret";
      h.deps.fetchImpl = (async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(sensitiveDetail), { code }),
        });
      }) as typeof fetch;
      const app = createGatewayApp(h.deps);
      const msg = `Remote upstream 'box' is unavailable: ${category}.`;
      const o = await app.fetch(
        post("/v1/responses", { model: "box--gpt-5-remote" }, headers),
      );
      assert.strictEqual(o.status, status);
      assert.ok((await o.json()).error.message.startsWith(msg));
      const a = await app.fetch(
        post("/v1/messages", { model: "box--gpt-5-remote" }, headers),
      );
      assert.strictEqual(a.status, status);
      const aj = await a.json();
      assert.strictEqual(aj.type, "error");
      assert.ok(aj.error.message.startsWith(msg));
      const g = await app.fetch(
        post("/v1beta/models/box--gpt-5-remote:countTokens", {}, headers),
      );
      assert.strictEqual(g.status, status);
      assert.strictEqual((await g.json()).error.code, status);
      assert.ok(
        h.logs.some(
          (l) =>
            /^\[[^\]]+\] Remote upstream "box" unavailable: /.test(l) &&
            l.includes(category),
        ),
      );
      assert.ok(h.logs.some((l) => l.includes(headers["x-request-id"])));
      assert.ok(!h.logs.some((l) => l.includes(sensitiveDetail)));
    });
  }

  test("connection refused (closed port) suggests devtunnel host", async () => {
    const h = harness();
    h.deps.fetchImpl = undefined;
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r));
    h.deps.getRemote = (name) => ({ name, url: `http://127.0.0.1:${port}` });
    const app = createGatewayApp(h.deps);
    const r = await app.fetch(
      post("/v1/messages", { model: "box--gpt-5-remote" }),
    );
    assert.strictEqual(r.status, 502);
    assert.strictEqual(
      (await r.json()).error.message,
      "Remote upstream 'box' is unavailable: connection refused. Check that devtunnel host is running on that machine.",
    );
  });

  for (const status of [401, 403]) {
    test(`remote ${status} passes through and logs a credential hint`, async () => {
      const h = harness();
      h.deps.fetchImpl = (async () =>
        new Response('{"error":"no"}', { status })) as typeof fetch;
      const app = createGatewayApp(h.deps);
      const r = await app.fetch(
        post("/v1/messages", { model: "box--gpt-5-remote" }),
      );
      assert.strictEqual(r.status, status);
      assert.strictEqual(await r.text(), '{"error":"no"}');
      assert.ok(
        h.logs.some((l) =>
          l.includes(
            `remote "box" rejected the gateway credentials (HTTP ${status}); set the key with 'Agent Gateway: Manage Remote Upstreams'`,
          ),
        ),
      );
      assert.ok(!h.logs.some((l) => l.includes("remote-secret")));
    });
  }
});

suite("Gateway app troubleshooting", () => {
  test("every response carries request-id and x-request-id and errors include it in the body", async () => {
    const app = createGatewayApp(harness().deps);
    const ok = await app.fetch(get("/v1/models"));
    assert.match(ok.headers.get("x-request-id") ?? "", /^req_[A-Za-z0-9]{24}$/);
    assert.strictEqual(
      ok.headers.get("request-id"),
      ok.headers.get("x-request-id"),
    );

    const bad = await app.fetch(post("/v1/messages", { nope: true }));
    const id = bad.headers.get("x-request-id");
    assert.ok(id);
    assert.strictEqual(bad.headers.get("request-id"), id);
    const body = (await bad.json()) as { request_id?: string };
    assert.strictEqual(body.request_id, id);
  });

  test("a safe caller x-request-id is reused, an unsafe one is replaced", async () => {
    const app = createGatewayApp(harness().deps);
    const reused = await app.fetch(
      get("/v1/models", { "x-request-id": "client-abc.1" }),
    );
    assert.strictEqual(reused.headers.get("x-request-id"), "client-abc.1");
    const replaced = await app.fetch(
      get("/v1/models", { "x-request-id": "bad id <script>" }),
    );
    assert.notStrictEqual(
      replaced.headers.get("x-request-id"),
      "bad id <script>",
    );
    assert.match(replaced.headers.get("x-request-id") ?? "", /^req_/);
  });

  test("request-id and X-Client-Request-Id from the caller are reused", async () => {
    const app = createGatewayApp(harness().deps);
    const a = await app.fetch(get("/v1/models", { "request-id": "req_abc" }));
    assert.strictEqual(a.headers.get("request-id"), "req_abc");
    const o = await app.fetch(
      get("/v1/models", { "x-client-request-id": "client-7" }),
    );
    assert.strictEqual(o.headers.get("x-request-id"), "client-7");
  });

  test("the request ID is forwarded to remote gateways", async () => {
    const h = harness();
    const app = createGatewayApp(h.deps);
    const res = await app.fetch(
      post("/v1/messages", { model: "box--gpt-5-remote", messages: [] }),
    );
    assert.strictEqual(
      h.remote[0].headers.get("x-request-id"),
      res.headers.get("x-request-id"),
    );
  });

  test("failed requests are recorded in the error journal without bodies", async () => {
    const { ErrorJournal } = await import("../../gateway/errorJournal");
    const h = harness();
    const journal = new ErrorJournal(undefined);
    const app = createGatewayApp({ ...h.deps, errorJournal: journal });
    await app.fetch(post("/v1/messages", { model: "", secret: "prompt text" }));
    await app.fetch(get("/v1/models"));
    const recent = journal.recentErrors();
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].status, 400);
    assert.strictEqual(recent[0].path, "/v1/messages");
    assert.ok(!JSON.stringify(recent).includes("prompt text"));
    assert.deepStrictEqual(journal.countsByKind(), { "400 http": 1 });
  });
});
