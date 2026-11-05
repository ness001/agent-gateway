import * as assert from "assert";
import { parse as parseJsonc } from "jsonc-parser";

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
const backup = "C:\\Users\\me\\.config\\kilo\\agent-gateway-default.json";

suite("kilo adapter", () => {
  test("metadata and paths", () => {
    assert.strictEqual(kiloAdapter.id, "kilo");
    assert.strictEqual(kiloAdapter.discovery, "static");
    assert.deepStrictEqual(kiloAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.config/kilo/kilo.jsonc",
      "/home/me/.config/kilo/kilo.json",
      "/home/me/.config/kilo/agent-gateway-default.json",
    ]);
  });

  test("creates kilo.jsonc with an openai-compatible provider", () => {
    const plan = kiloAdapter.plan(input(), {});
    assert.strictEqual(plan.changes.find((c) => c.path === jsonc)!.path, jsonc);
    const cfg = parseJsonc(plan.changes.find((c) => c.path === jsonc)!.after!);
    const p = cfg.provider["agent-gateway"];
    assert.strictEqual(p.npm, "@ai-sdk/openai-compatible");
    assert.strictEqual(p.options.baseURL, "http://127.0.0.1:24444/v1");
    assert.strictEqual(p.options.apiKey, PLACEHOLDER_API_KEY);
    assert.strictEqual(cfg.model, "agent-gateway/gpt-5");
    assert.deepStrictEqual(
      JSON.parse(plan.changes.find((c) => c.path === backup)!.after!),
      {
        model: null,
        configExisted: false,
      },
    );
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
    const configured = plan.changes.find((c) => c.path === json)!.after!;
    const removed = kiloAdapter.unplan(input(), {
      [json]: configured,
      [backup]: plan.changes.find((c) => c.path === backup)!.after,
    });
    assert.strictEqual(
      parseJsonc(removed.changes.find((c) => c.path === json)!.after!).model,
      undefined,
    );
    assert.notStrictEqual(
      removed.changes.find((c) => c.path === json)!.after,
      undefined,
    );
  });

  test("preserves user config and comments, idempotent, unplan restores", () => {
    const before =
      '{\n  // mine\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "openai/old",\n  "provider": { "openai": {} }\n}\n';
    const plan = kiloAdapter.plan(input(), { [jsonc]: before });
    const after = plan.changes.find((c) => c.path === jsonc)!.after!;
    const backupAfter = plan.changes.find((c) => c.path === backup)!.after!;
    assert.deepStrictEqual(JSON.parse(backupAfter), {
      model: "openai/old",
      configExisted: true,
    });
    assert.ok(after.includes("// mine"));
    assert.ok(after.includes('"openai"'));
    assert.deepStrictEqual(
      kiloAdapter.plan(input(), { [jsonc]: after, [backup]: backupAfter })
        .changes,
      [],
    );
    const un = kiloAdapter
      .unplan(input(), {
        [jsonc]: after,
        [backup]: backupAfter,
      })
      .changes.find((c) => c.path === jsonc)!;
    const cfg = JSON.parse(un.after!.replace("// mine", ""));
    assert.deepStrictEqual(cfg.provider, { openai: {} });
    assert.strictEqual(cfg.model, "openai/old");
    assert.deepStrictEqual(
      kiloAdapter.unplan(input(), { [jsonc]: un.after! }).changes,
      [],
    );
  });

  test("unplan deletes a file it created", () => {
    const plan = kiloAdapter.plan(input(), {});
    const changes = kiloAdapter.unplan(input(), {
      [jsonc]: plan.changes.find((c) => c.path === jsonc)!.after,
      [backup]: plan.changes.find((c) => c.path === backup)!.after,
    }).changes;
    assert.strictEqual(changes.find((c) => c.path === jsonc)?.after, undefined);
    assert.strictEqual(
      changes.find((c) => c.path === backup)?.after,
      undefined,
    );
  });

  test("reconfigure keeps the original startup model", () => {
    const before = '{"model":"other/old"}\n';
    const first = kiloAdapter.plan(input(), { [json]: before });
    const updated = kiloAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [json]: first.changes.find((c) => c.path === json)?.after,
      [backup]: first.changes.find((c) => c.path === backup)?.after,
    });
    assert.strictEqual(
      parseJsonc(updated.changes.find((c) => c.path === json)!.after!).model,
      "agent-gateway/claude-sonnet",
    );
    const restored = kiloAdapter.unplan(input(), {
      [json]: updated.changes.find((c) => c.path === json)?.after,
      [backup]: first.changes.find((c) => c.path === backup)?.after,
    });
    assert.strictEqual(
      parseJsonc(restored.changes.find((c) => c.path === json)!.after!).model,
      "other/old",
    );
  });

  test("removes a managed default if the provider entry is missing", () => {
    const configured = kiloAdapter.plan(input(), {
      [jsonc]: '{"model":"other/old"}',
    });
    const withoutProvider = '{"model":"agent-gateway/gpt-5"}';
    const changes = kiloAdapter.unplan(input(), {
      [jsonc]: withoutProvider,
      [backup]: configured.changes.find((c) => c.path === backup)?.after,
    }).changes;
    assert.strictEqual(
      parseJsonc(changes.find((c) => c.path === jsonc)!.after!).model,
      "other/old",
    );
    assert.strictEqual(
      changes.find((c) => c.path === backup)?.after,
      undefined,
    );
  });

  test("upgrades a legacy gateway default without inventing a previous model", () => {
    const legacy =
      '{"model":"agent-gateway/gpt-5","provider":{"agent-gateway":{}}}';
    const updated = kiloAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [jsonc]: legacy,
    });
    assert.ok(!updated.changes.some((c) => c.path === backup));
    const current = updated.changes.find((c) => c.path === jsonc)!.after!;
    assert.strictEqual(
      parseJsonc(current).model,
      "agent-gateway/claude-sonnet",
    );
    const removed = kiloAdapter.unplan(input(), { [jsonc]: current });
    assert.ok(!removed.changes.some((c) => c.path === backup));
    const restored = removed.changes.find((c) => c.path === jsonc)?.after;
    assert.strictEqual(
      restored === undefined ? undefined : parseJsonc(restored).model,
      undefined,
    );
  });

  test("rejects malformed configuration instead of discarding the backup", () => {
    const configured = kiloAdapter.plan(input(), {
      [jsonc]: '{"model":"other/old"}',
    });
    assert.throws(
      () =>
        kiloAdapter.unplan(input(), {
          [jsonc]: "[]",
          [backup]: configured.changes.find((c) => c.path === backup)?.after,
        }),
      /must be an object/,
    );
  });

  test("rejects unparseable config", () => {
    assert.throws(() => kiloAdapter.plan(input(), { [jsonc]: "{ nope" }));
  });
});
