import * as assert from "assert";
import { parse } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

import { claudeCodeAdapter } from "../../clients/claudeCode";
import { codexAdapter } from "../../clients/codex";
import { selectedContextWindow } from "../../clients/contextWindow";
import { kiloAdapter } from "../../clients/kilo";
import { hermesAdapter } from "../../clients/openclawHermes";
import type { ClientConfigInput } from "../../clients/types";

const input: ClientConfigInput = {
  gatewayUrl: "http://127.0.0.1:24444",
  home: "/home/test",
  platform: "linux",
  defaultModel: "gpt-test",
  models: [
    {
      id: "gpt-test",
      displayName: "Test",
      contextWindow: 900000,
      inputModalities: ["text"],
      supportsToolCalling: true,
      reasoning: true,
    },
  ],
};
const claudeFile = "/home/test/.claude/settings.json";
const codexFile = "/home/test/.codex/config.toml";
function claude(text: string | undefined, config = input): string {
  return (
    claudeCodeAdapter.plan(config, { [claudeFile]: text }).changes[0]?.after ??
    text!
  );
}
function codex(text: string | undefined, config = input): string {
  return (
    codexAdapter.plan(config, { [codexFile]: text }).changes[0]?.after ?? text!
  );
}
suite("configured context windows", () => {
  test("exact model metadata wins over alias and suffix fallback", () => {
    const models = [
      ...input.models,
      {
        ...input.models[0],
        id: "gateway-claude-gpt-test[1m]",
        contextWindow: 300000,
      },
    ];
    assert.strictEqual(
      selectedContextWindow({
        ...input,
        models,
        defaultModel: "gateway-claude-gpt-test[1m]",
      }),
      300000,
    );
  });
  test("Claude updates capacity when the selected model changes and restores original", () => {
    const before = JSON.stringify({
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "150000" },
    });
    const once = claude(before);
    const next = claude(once, {
      ...input,
      defaultModel: "other",
      models: [{ ...input.models[0], id: "other", contextWindow: 64000 }],
    });
    assert.strictEqual(parse(next).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "64000");
    assert.deepStrictEqual(
      parse(
        claudeCodeAdapter.unplan(input, { [claudeFile]: next }).changes[0]
          .after!,
      ),
      parse(before),
    );
  });
  test("Codex upgrades legacy backups and leaves nested context settings alone", () => {
    const before =
      "model_context_window = 150000\n\n[other]\nmodel_context_window = 32000\n";
    const legacy = codex(before, { ...input, models: [] });
    const configured = codex(legacy);
    assert.match(configured, /^model_context_window = 900000$/m);
    assert.ok(configured.includes("[other]\nmodel_context_window = 32000"));
    assert.strictEqual(
      codexAdapter.unplan(input, { [codexFile]: configured }).changes[0].after,
      before,
    );
  });
  test("Kilo writes context independently of missing output metadata", () => {
    const plan = kiloAdapter.plan(input, {});
    const value = parse(plan.changes[0].after!).provider["agent-gateway"]
      .models["gpt-test"];
    assert.deepStrictEqual(value.limit, { context: 900000 });
  });
  test("Hermes writes per-model capacities and refreshes removed or unknown metadata", () => {
    const plan = hermesAdapter.plan(input, {});
    const file = plan.changes[0].path;
    const text = plan.changes[0].after!;
    assert.deepStrictEqual(parseYaml(text).providers["agent-gateway"].models, {
      "gpt-test": { context_length: 900000 },
    });
    assert.strictEqual(
      hermesAdapter.plan(input, { [file]: text }).changes.length,
      0,
    );
    const changed = hermesAdapter.plan(
      { ...input, models: [] },
      { [file]: text },
    ).changes[0].after!;
    assert.deepStrictEqual(
      parseYaml(changed).providers["agent-gateway"].models,
      {},
    );
  });
  test("Claude writes selected capacity and preserves output and compaction settings", () => {
    const before = JSON.stringify({
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
      },
    });
    const once = claude(before);
    assert.strictEqual(
      parse(once).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      "900000",
    );
    assert.strictEqual(parse(once).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "32000");
    assert.strictEqual(parse(once).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "85");
    assert.strictEqual(claude(once), once);
    const back = claudeCodeAdapter.unplan(input, { [claudeFile]: once })
      .changes[0].after!;
    assert.deepStrictEqual(parse(back), parse(before));
  });
  test("Claude resolves alias, suffix and remote IDs without inventing a capacity", () => {
    for (const id of [
      "gpt-test",
      "gateway-claude-gpt-test",
      "gateway-claude-gpt-test[1m]",
    ]) {
      assert.strictEqual(
        parse(claude(undefined, { ...input, defaultModel: id })).env
          .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        "900000",
      );
    }
    const remote = {
      ...input,
      defaultModel: "gateway-claude-office--gpt-test",
      models: [
        { ...input.models[0], id: "office--gpt-test", contextWindow: 120000 },
      ],
    };
    assert.strictEqual(
      parse(claude(undefined, remote)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      "120000",
    );
    assert.strictEqual(
      parse(claude(undefined, { ...input, defaultModel: "missing" })).env
        .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      undefined,
    );
  });
  test("Claude clears stale gateway capacity for unknown models and restores legacy values", () => {
    const before = JSON.stringify({
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        AGENT_GATEWAY_PREVIOUS: JSON.stringify({ ANTHROPIC_MODEL: "opus" }),
      },
    });
    const once = claude(before);
    const unknown = claude(once, { ...input, models: [] });
    assert.strictEqual(
      parse(unknown).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      "200000",
    );
    const legacyBack = claudeCodeAdapter.unplan(input, { [claudeFile]: before })
      .changes[0].after!;
    assert.strictEqual(
      parse(legacyBack).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      "200000",
    );
    const fresh = claude(undefined);
    assert.strictEqual(
      parse(claude(fresh, { ...input, models: [] })).env
        .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      undefined,
    );
  });
  test("Codex writes selected capacity, updates on model change, restores original", () => {
    const before =
      'model = "old"\nmodel_context_window = 200000\n\n[other]\nkeep = true\n';
    const once = codex(before);
    assert.match(once, /^model_context_window = 900000$/m);
    assert.ok(once.includes("[other]\nkeep = true"));
    assert.strictEqual(codex(once), once);
    const next = codex(once, {
      ...input,
      models: [{ ...input.models[0], contextWindow: 100000 }],
    });
    assert.match(next, /^model_context_window = 100000$/m);
    const back = codexAdapter.unplan(input, { [codexFile]: next }).changes[0]
      .after!;
    assert.strictEqual(back, before);
  });
  test("Codex unknown capacity does not retain stale gateway capacity", () => {
    const once = codex(undefined);
    const unknown = codex(once, { ...input, models: [] });
    assert.ok(!unknown.includes("model_context_window"));
    const before = "model_context_window = 200000\n";
    assert.match(
      codex(codex(before), { ...input, models: [] }),
      /^model_context_window = 200000$/m,
    );
  });
  test("invalid metadata is not written", () => {
    for (const contextWindow of [null, 0, -1, 1.5, NaN, Infinity]) {
      const cfg = { ...input, models: [{ ...input.models[0], contextWindow }] };
      assert.strictEqual(
        parse(claude(undefined, cfg)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        undefined,
      );
      assert.ok(!codex(undefined, cfg).includes("model_context_window"));
    }
  });
});
