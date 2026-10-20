import * as assert from "assert";

import { ompAdapter, piAdapter } from "../../clients/ompPi";
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
    inputModalities: ["text", "image", "audio"],
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
  {
    id: "copilot-utility-small",
    displayName: "u",
    contextWindow: 1,
    inputModalities: ["text"],
    supportsToolCalling: true,
    reasoning: false,
  },
];

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444",
    models,
    defaultModel: "gpt-5",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

const ompYml = "C:\\Users\\me\\.omp\\agent\\models.yml";
const ompYaml = "C:\\Users\\me\\.omp\\agent\\models.yaml";
const piJson = "C:\\Users\\me\\.pi\\agent\\models.json";

suite("omp adapter", () => {
  test("metadata and paths", () => {
    assert.strictEqual(ompAdapter.id, "omp");
    assert.strictEqual(ompAdapter.discovery, "auto");
    assert.deepStrictEqual(ompAdapter.configPaths("C:\\Users\\me", "win32"), [
      ompYml,
      ompYaml,
    ]);
    assert.deepStrictEqual(ompAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.omp/agent/models.yml",
      "/home/me/.omp/agent/models.yaml",
    ]);
  });

  test("creates models.yml with discovery provider and placeholder key", () => {
    const plan = ompAdapter.plan(input(), {});
    assert.strictEqual(plan.changes.length, 1);
    const after = plan.changes[0].after!;
    assert.strictEqual(plan.changes[0].path, ompYml);
    assert.match(after, /agent-gateway:/);
    assert.match(after, /baseUrl: http:\/\/127\.0\.0\.1:24444\/v1/);
    assert.match(after, new RegExp(`apiKey: ${PLACEHOLDER_API_KEY}`));
    assert.match(after, /api: openai-responses/);
    assert.match(after, /type: openai-models-list/);
    assert.match(after, /injectV1: false/);
  });

  test("preserves comments and other providers, idempotent, edits models.yaml when alone", () => {
    const before =
      "# my config\nproviders:\n  other:\n    # keep\n    baseUrl: http://x\n";
    const files = { [ompYaml]: before };
    const plan = ompAdapter.plan(input({ apiKey: "k" }), files);
    assert.strictEqual(plan.changes[0].path, ompYaml);
    const after = plan.changes[0].after!;
    assert.ok(after.startsWith("# my config\n"));
    assert.match(after, /other:\n {4}# keep/);
    assert.match(after, /apiKey: k/);
    const again = ompAdapter.plan(input({ apiKey: "k" }), { [ompYaml]: after });
    assert.strictEqual(again.changes.length, 0);

    const un = ompAdapter.unplan(input(), { [ompYaml]: after });
    assert.strictEqual(un.changes[0].after, before);
  });

  test("prefers models.yml over models.yaml", () => {
    const plan = ompAdapter.plan(input(), {
      [ompYml]: "a: 1\n",
      [ompYaml]: "b: 2\n",
    });
    assert.strictEqual(plan.changes[0].path, ompYml);
  });

  test("unplan of a file plan() created deletes it", () => {
    const after = ompAdapter.plan(input(), {}).changes[0].after!;
    const un = ompAdapter.unplan(input(), { [ompYml]: after });
    assert.strictEqual(un.changes[0].after, undefined);
  });
});

suite("pi adapter", () => {
  test("metadata and posix path", () => {
    assert.strictEqual(piAdapter.id, "pi");
    assert.strictEqual(piAdapter.discovery, "static");
    assert.deepStrictEqual(piAdapter.configPaths("/home/me", "darwin"), [
      "/home/me/.pi/agent/models.json",
    ]);
  });

  test("writes filtered static model list", () => {
    const plan = piAdapter.plan(input(), {});
    const cfg = JSON.parse(plan.changes[0].after!);
    const p = cfg.providers["agent-gateway"];
    assert.strictEqual(p.baseUrl, "http://127.0.0.1:24444/v1");
    assert.strictEqual(p.api, "openai-responses");
    assert.strictEqual(p.apiKey, PLACEHOLDER_API_KEY);
    assert.deepStrictEqual(p.models, [
      {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 128000,
      },
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  test("keeps comments/other providers, refreshes list, idempotent, unplan restores", () => {
    const before =
      '{\n  // note\n  "providers": {\n    "other": { "baseUrl": "http://x" }\n  }\n}\n';
    const after = piAdapter.plan(input({ apiKey: "k" }), { [piJson]: before })
      .changes[0].after!;
    assert.match(after, /\/\/ note/);
    assert.match(after, /"other"/);
    assert.strictEqual(
      piAdapter.plan(input({ apiKey: "k" }), { [piJson]: after }).changes
        .length,
      0,
    );

    const refreshed = piAdapter.plan(
      input({ apiKey: "k", models: [models[1]] }),
      { [piJson]: after },
    ).changes[0].after!;
    assert.ok(!refreshed.includes("gpt-5"));

    const un = piAdapter.unplan(input(), { [piJson]: after }).changes[0].after!;
    assert.match(un, /\/\/ note/);
    assert.match(un, /"other"/);
    assert.ok(!un.includes("agent-gateway"));
  });

  test("unplan of a file plan() created deletes it; missing file is a no-op", () => {
    const after = piAdapter.plan(input(), {}).changes[0].after!;
    assert.strictEqual(
      piAdapter.unplan(input(), { [piJson]: after }).changes[0].after,
      undefined,
    );
    assert.strictEqual(piAdapter.unplan(input(), {}).changes.length, 0);
  });
});
