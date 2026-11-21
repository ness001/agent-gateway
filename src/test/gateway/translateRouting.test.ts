import * as assert from "node:assert";

import { type GatewayAppDeps, createGatewayApp } from "../../gateway/app";
import { buildRegistry } from "../../gateway/catalog";
import { ALL_OPERATIONS, type ModelInfo } from "../../gateway/types";

const chatOnly: ModelInfo = {
  id: "m",
  displayName: "m",
  contextWindow: 100000,
  inputModalities: ["text"],
  supportsToolCalling: null,
  defaultReasoningLevel: "medium",
  supportedReasoningLevels: [],
  operations: [...ALL_OPERATIONS],
  nativeOperations: ["openai.chatCompletions"],
};

function harness(withTranslation = true) {
  const translated: Request[] = [];
  const forwarded: { url: string; body: string }[] = [];
  const registry = buildRegistry([], [{ name: "box", models: [chatOnly] }]);
  const deps: GatewayAppDeps = {
    getRegistry: () => registry,
    getLocalModels: () => [],
    handleLocal: async () => new Response("local", { status: 500 }),
    getRemote: (name) =>
      name === "box" ? { name, url: "http://remote.test" } : undefined,
    getRemoteApiKey: async () => undefined,
    getApiKey: async () => undefined,
    getHealth: () => ({ status: "Ready" }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetchImpl: (async (url: string, init: RequestInit) => {
      forwarded.push({ url, body: init.body as string });
      return new Response('{"remote":true}');
    }) as typeof fetch,
  };
  if (withTranslation) {
    deps.handleTranslated = async (req) => {
      translated.push(req);
      return new Response('{"translated":true}', {
        headers: { "content-type": "application/json" },
      });
    };
  }
  return { app: createGatewayApp(deps), translated, forwarded, registry };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:24444${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

suite("Translated remote routing", () => {
  test("registry keeps native operations on remote and alias entries", () => {
    const { registry } = harness();
    for (const id of ["box--m", "gateway-claude-box--m"]) {
      const e = registry.find((r) => r.id === id)!;
      assert.deepStrictEqual(e.nativeOperations, ["openai.chatCompletions"]);
    }
  });

  test("native Chat Completions is forwarded unchanged", async () => {
    const h = harness();
    const res = await h.app.fetch(
      post("/v1/chat/completions", { model: "box--m", messages: [] }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.translated.length, 0);
    assert.strictEqual(
      h.forwarded[0].url,
      "http://remote.test/v1/chat/completions",
    );
    assert.strictEqual(JSON.parse(h.forwarded[0].body).model, "m");
  });

  test("Anthropic Messages goes to the translator with the gateway ID", async () => {
    const h = harness();
    const res = await h.app.fetch(
      post("/v1/messages", { model: "gateway-claude-box--m", messages: [] }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.forwarded.length, 0);
    assert.strictEqual(h.translated.length, 1);
    const req = h.translated[0];
    assert.strictEqual(new URL(req.url).pathname, "/v1/messages");
    assert.strictEqual(
      ((await req.json()) as { model: string }).model,
      "gateway-claude-box--m",
    );
  });

  test("Gemini and Responses are translated too", async () => {
    const h = harness();
    await h.app.fetch(
      post("/v1beta/models/box--m:generateContent", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    );
    await h.app.fetch(post("/v1/responses", { model: "box--m", input: "hi" }));
    assert.strictEqual(h.forwarded.length, 0);
    assert.deepStrictEqual(
      h.translated.map((r) => new URL(r.url).pathname),
      ["/v1beta/models/box--m:generateContent", "/v1/responses"],
    );
  });

  test("without a translator, non-native APIs are refused", async () => {
    const h = harness(false);
    const res = await h.app.fetch(
      post("/v1/messages", { model: "box--m", messages: [] }),
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(h.forwarded.length, 0);
  });
});
