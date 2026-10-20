import * as assert from "assert";

import { kiloAdapter } from "../../clients/kilo";
import {
  type ClientConfigInput,
  type GatewayModel,
  PLACEHOLDER_API_KEY,
} from "../../clients/types";

const models: GatewayModel[] = [
  {
    id: "gpt-5",
    displayName: "GPT-5",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputModalities: ["text", "image"],
    supportsToolCalling: true,
    reasoning: true,
  },
  {
    id: "claude-sonnet",
    displayName: "Claude Sonnet",
    contextWindow: null,
    inputModalities: ["text"],
    supportsToolCalling: null,
    reasoning: false,
  },
  {
    id: "no-tools",
    displayName: "x",
    contextWindow: 1,
    inputModalities: ["text"],
    supportsToolCalling: false,
    reasoning: false,
  },
];

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444/",
    models,
    defaultModel: "gpt-5",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

const jsonc = "C:\\Users\\me\\.config\\kilo\\kilo.jsonc";
const json = "C:\\Users\\me\\.config\\kilo\\kilo.json";

suite("kilo adapter", () => {
  test("metadata and paths", () => {
    assert.strictEqual(kiloAdapter.id, "kilo");
    assert.strictEqual(kiloAdapter.discovery, "static");
    assert.deepStrictEqual(kiloAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.config/kilo/kilo.jsonc",
      "/home/me/.config/kilo/kilo.json",
    ]);
  });

  test("creates kilo.jsonc with an openai-compatible provider", () => {
    const plan = kiloAdapter.plan(input(), {});
    assert.strictEqual(plan.changes[0].path, jsonc);
    const cfg = JSON.parse(plan.changes[0].after!);
    const p = cfg.provider["agent-gateway"];
    assert.strictEqual(p.npm, "@ai-sdk/openai-compatible");
    assert.strictEqual(p.options.baseURL, "http://127.0.0.1:24444/v1");
    assert.strictEqual(p.options.apiKey, PLACEHOLDER_API_KEY);
    assert.deepStrictEqual(Object.keys(p.models), ["gpt-5", "claude-sonnet"]);
    assert.deepStrictEqual(p.models["gpt-5"], {
      name: "GPT-5",
      tool_call: true,
      reasoning: true,
      attachment: true,
      limit: { context: 400000, output: 128000 },
    });
    assert.strictEqual(p.models["claude-sonnet"].limit, undefined);
  });

  test("edits kilo.json when it is the only file", () => {
    const plan = kiloAdapter.plan(input(), { [json]: "{}" });
    assert.strictEqual(plan.changes[0].path, json);
  });

  test("preserves user config and comments, idempotent, unplan restores", () => {
    const before =
      '{\n  // mine\n  "$schema": "https://app.kilo.ai/config.json",\n  "provider": { "openai": {} }\n}\n';
    const after = kiloAdapter.plan(input(), { [jsonc]: before }).changes[0]
      .after!;
    assert.ok(after.includes("// mine"));
    assert.ok(after.includes('"openai"'));
    assert.deepStrictEqual(
      kiloAdapter.plan(input(), { [jsonc]: after }).changes,
      [],
    );
    const un = kiloAdapter.unplan(input(), { [jsonc]: after }).changes[0];
    const cfg = JSON.parse(un.after!.replace("// mine", ""));
    assert.deepStrictEqual(cfg.provider, { openai: {} });
    assert.deepStrictEqual(
      kiloAdapter.unplan(input(), { [jsonc]: un.after! }).changes,
      [],
    );
  });

  test("unplan deletes a file it created", () => {
    const after = kiloAdapter.plan(input(), {}).changes[0].after!;
    assert.strictEqual(
      kiloAdapter.unplan(input(), { [jsonc]: after }).changes[0].after,
      undefined,
    );
  });

  test("rejects unparseable config", () => {
    assert.throws(() => kiloAdapter.plan(input(), { [jsonc]: "{ nope" }));
  });
});
