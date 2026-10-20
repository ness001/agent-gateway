import * as assert from "assert";
import { parse as parseYaml } from "yaml";

import { deepseekHarnessAdapter, dshHome } from "../../clients/deepseekHarness";
import { ClientConfigInput, PLACEHOLDER_API_KEY } from "../../clients/types";

const input: ClientConfigInput = {
  gatewayUrl: "http://127.0.0.1:24444",
  models: [
    {
      id: "claude-sonnet-4.5",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxOutputTokens: 32000,
      inputModalities: ["text", "image"],
      supportsToolCalling: true,
      reasoning: true,
    },
    {
      id: "no-tools",
      displayName: "No Tools",
      contextWindow: null,
      inputModalities: ["text"],
      supportsToolCalling: false,
      reasoning: false,
    },
  ],
  defaultModel: "claude-sonnet-4.5",
  home: "C:\\Users\\me",
  platform: "win32",
};
const P = "C:\\Users\\me\\.dsh\\cordis.patch.yml";

function entry(list: any[], id: string): any {
  return list.find((e) => e.id === id);
}

suite("deepseekHarnessAdapter", () => {
  test("home honours DSH_HOME, else ~/.dsh", () => {
    assert.strictEqual(dshHome("/home/me", "linux", {}), "/home/me/.dsh");
    assert.strictEqual(
      dshHome("/home/me", "linux", { DSH_HOME: "/opt/dsh" }),
      "/opt/dsh",
    );
    assert.strictEqual(dshHome(input.home, "win32", {}), "C:\\Users\\me\\.dsh");
  });

  test("creates route and default model in a new file", () => {
    const plan = deepseekHarnessAdapter.plan(input, {});
    assert.strictEqual(plan.changes[0].path, P);
    const v = parseYaml(plan.changes[0].after!);
    const route = entry(v, "llm-pi-ai").config.providers["agent-gateway"];
    assert.strictEqual(route.api, "anthropic-messages");
    assert.strictEqual(route.baseURL, "http://127.0.0.1:24444");
    assert.strictEqual(route.headers["x-api-key"], PLACEHOLDER_API_KEY);
    assert.deepStrictEqual(route.models, [
      {
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ]);
    assert.deepStrictEqual(entry(v, "agent-default-model").config, {
      provider: "agent-gateway",
      model: "claude-sonnet-4.5",
    });
  });

  test("is idempotent and preserves unrelated entries", () => {
    const start =
      "# mine\n- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        apiKeyEnv: OPENAI_API_KEY\n- id: timer\n  disabled: true\n";
    const first = deepseekHarnessAdapter.plan(input, { [P]: start }).changes[0]
      .after!;
    const second = deepseekHarnessAdapter.plan(input, { [P]: first });
    assert.deepStrictEqual(second.changes, []);
    const v = parseYaml(first);
    assert.ok(entry(v, "llm-pi-ai").config.providers.openai);
    assert.strictEqual(entry(v, "timer").disabled, true);
    assert.ok(first.includes("# mine"));
  });

  test("unplan restores the previous default model and other providers", () => {
    const start =
      "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-pro\n- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        apiKeyEnv: OPENAI_API_KEY\n";
    const applied = deepseekHarnessAdapter.plan(input, { [P]: start })
      .changes[0].after!;
    const reapplied = deepseekHarnessAdapter.plan(
      { ...input, defaultModel: "other" },
      { [P]: applied },
    ).changes[0].after!;
    const reverted = deepseekHarnessAdapter.unplan(input, { [P]: reapplied })
      .changes[0].after!;
    assert.deepStrictEqual(parseYaml(reverted), parseYaml(start));
    assert.ok(!reverted.includes("agent-gateway"));
  });

  test("unplan of a file it created leaves an empty list", () => {
    const applied = deepseekHarnessAdapter.plan(input, { [P]: "[]\n" })
      .changes[0].after!;
    const reverted = deepseekHarnessAdapter.unplan(input, { [P]: applied })
      .changes[0].after!;
    assert.deepStrictEqual(parseYaml(reverted), []);
  });

  test("refuses a non-list file", () => {
    const plan = deepseekHarnessAdapter.plan(input, { [P]: "a: 1\n" });
    assert.deepStrictEqual(plan.changes, []);
    assert.ok(plan.manualSteps);
  });
});
