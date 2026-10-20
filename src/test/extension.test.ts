import * as assert from "node:assert";
import * as vscode from "vscode";

import { createGatewayApp } from "../gateway/app";
import { buildRegistry } from "../gateway/catalog";
import { toModelInfo } from "../gateway/discovery";
import { start } from "../gateway/listen";
import { createLocalHandler } from "../gateway/localRoutes";

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function fakeModel(
  sendRequest: vscode.LanguageModelChat["sendRequest"],
): vscode.LanguageModelChat {
  return {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    family: "claude-sonnet-4.6",
    version: "4.6",
    vendor: "copilot",
    maxInputTokens: 200000,
    capabilities: { supportsImageToText: false, supportsToolCalling: true },
    sendRequest,
    countTokens: async () => 1,
  } as unknown as vscode.LanguageModelChat;
}

function appFor(model: vscode.LanguageModelChat) {
  const info = toModelInfo(model as never);
  const registry = buildRegistry([info], []);
  return createGatewayApp({
    getRegistry: () => registry,
    getLocalModels: () => [info],
    handleLocal: createLocalHandler({
      getLocalModel: (id) => (id === model.id ? model : undefined),
      maxSearchesPerRequest: 5,
    }),
    getRemote: () => undefined,
    getRemoteApiKey: async () => undefined,
    getApiKey: async () => undefined,
    getHealth: () => ({}),
    logger: silent,
  });
}

const body = (stream: boolean) =>
  JSON.stringify({
    model: "gateway-claude-claude-sonnet-4.6",
    max_tokens: 50,
    stream,
    messages: [{ role: "user", content: "hi" }],
  });

suite("Extension", () => {
  test("extension is present", () => {
    const ext = vscode.extensions.all.find(
      (e) => e.id.toLowerCase() === "ness001.agent-gateway",
    );
    assert.ok(ext, "gateway extension not loaded");
  });

  test("Anthropic non-streaming request reaches the fake model", async () => {
    const app = appFor(
      fakeModel(async () => ({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("Hello there");
        })(),
        text: (async function* () {})(),
      })),
    );
    const res = await app.fetch(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body(false),
      }),
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { content: { text: string }[] };
    assert.strictEqual(json.content[0].text, "Hello there");
  });

  test("Anthropic streaming request emits SSE events", async () => {
    const app = appFor(
      fakeModel(async () => ({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("Hel");
          yield new vscode.LanguageModelTextPart("lo");
        })(),
        text: (async function* () {})(),
      })),
    );
    const res = await app.fetch(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body(true),
      }),
    );
    const text = await res.text();
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes("event: message_stop"));
    assert.ok(text.includes("Hel"));
  });

  test("client disconnect cancels the CancellationToken", async () => {
    let cancelled!: () => void;
    const wasCancelled = new Promise<void>((r) => (cancelled = r));
    const model = fakeModel(async (_m, _o, token) => {
      token?.onCancellationRequested(() => cancelled());
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("start");
          await new Promise<void>((resolve) =>
            token?.onCancellationRequested(() => resolve()),
          );
        })(),
        text: (async function* () {})(),
      };
    });
    const listener = await start(appFor(model), 0);
    try {
      const controller = new AbortController();
      const res = await fetch(`${listener.address}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body(true),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await Promise.race([
        wasCancelled,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("not cancelled")), 5000),
        ),
      ]);
    } finally {
      await listener.close();
    }
  });
});
