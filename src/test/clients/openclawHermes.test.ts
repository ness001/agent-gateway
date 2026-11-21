import * as assert from "assert";
import { parse } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

import {
  hermesAdapter,
  hermesHome,
  openclawAdapter,
  openclawConfigPath,
  openclawStateDir,
} from "../../clients/openclawHermes";
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
const OC = "C:\\Users\\me\\.openclaw\\openclaw.json";
const HM = "C:\\Users\\me\\AppData\\Local\\hermes\\config.yaml";
const HB = "C:\\Users\\me\\AppData\\Local\\hermes\\agent-gateway-default.json";

suite("openclawAdapter", () => {
  test("config path: ~/.openclaw on all platforms; OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH override", () => {
    assert.strictEqual(
      openclawConfigPath("C:\\Users\\me", "win32", {}),
      "C:\\Users\\me\\.openclaw\\openclaw.json",
    );
    assert.strictEqual(
      openclawConfigPath("/home/me", "linux", {}),
      "/home/me/.openclaw/openclaw.json",
    );
    assert.strictEqual(
      openclawConfigPath("/home/me", "linux", { OPENCLAW_HOME: "/srv/oc" }),
      "/srv/oc/.openclaw/openclaw.json",
    );
    assert.strictEqual(
      openclawStateDir("/home/me", "linux", { OPENCLAW_STATE_DIR: "~/state" }),
      "/home/me/state",
    );
    assert.strictEqual(
      openclawConfigPath("/home/me", "linux", {
        OPENCLAW_STATE_DIR: "/s",
        OPENCLAW_CONFIG_PATH: "/c/oc.json",
      }),
      "/c/oc.json",
    );
  });

  test("caveat states verification source", () => {
    assert.match(openclawAdapter.caveat ?? "", /not a live install/);
  });
  test("uses win32 path", () => {
    assert.deepStrictEqual(openclawAdapter.configPaths(input.home, "win32"), [
      OC,
    ]);
    assert.deepStrictEqual(openclawAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.openclaw/openclaw.json",
    ]);
  });

  test("creates provider, model list and primary in a new file", () => {
    const plan = openclawAdapter.plan(input, {});
    const v = parse(plan.changes[0].after!);
    assert.strictEqual(v.models.mode, "merge");
    const prov = v.models.providers["agent-gateway"];
    assert.strictEqual(prov.baseUrl, "http://127.0.0.1:24444");
    assert.strictEqual(prov.apiKey, PLACEHOLDER_API_KEY);
    assert.strictEqual(prov.api, "anthropic-messages");
    assert.deepStrictEqual(prov.models, [
      {
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ]);
    assert.strictEqual(
      v.agents.defaults.model.primary,
      "agent-gateway/claude-sonnet-4.5",
    );
  });

  test("preserves comments, other providers and existing mode; idempotent; unplan restores", () => {
    const before = `{
  // my config
  models: undefined,
}`.replace(
      "models: undefined,",
      `"models": { "mode": "replace", "providers": { "other": { "baseUrl": "x" } } },
  "agents": { "defaults": { "model": { "primary": "other/m" } } },`,
    );
    const first = openclawAdapter.plan(
      { ...input, apiKey: "k" },
      { [OC]: before },
    ).changes[0].after!;
    assert.ok(first.includes("// my config"));
    const v = parse(first);
    assert.strictEqual(v.models.mode, "replace");
    assert.strictEqual(v.models.providers.other.baseUrl, "x");
    assert.strictEqual(v.models.providers["agent-gateway"].apiKey, "k");
    const second = openclawAdapter.plan(
      { ...input, apiKey: "k" },
      { [OC]: first },
    );
    assert.strictEqual(second.changes.length, 0);
    const reverted = parse(
      openclawAdapter.unplan(input, { [OC]: first }).changes[0].after!,
    );
    assert.strictEqual(reverted.agents.defaults.model.primary, "other/m");
    assert.strictEqual(reverted.models.providers["agent-gateway"], undefined);
    assert.strictEqual(reverted.models.providers.other.baseUrl, "x");
  });

  test("unplan unsets primary when there was none", () => {
    const after = openclawAdapter.plan(input, {}).changes[0].after!;
    const reverted = openclawAdapter.unplan(input, { [OC]: after }).changes[0]
      .after!;
    assert.ok(!reverted.includes("agent-gateway"));
    assert.strictEqual(
      parse(reverted).agents.defaults.model.primary,
      undefined,
    );
  });

  test("refuses unquoted JSON5 keys", () => {
    const plan = openclawAdapter.plan(input, {
      [OC]: "{ models: { mode: 'merge' } }",
    });
    assert.strictEqual(plan.changes.length, 0);
    assert.ok(plan.manualSteps && plan.manualSteps.length > 0);
  });
});

suite("hermesAdapter", () => {
  test("metadata", () => {
    assert.strictEqual(hermesAdapter.discovery, "auto");
    assert.ok(hermesAdapter.caveat);
  });

  test("config lives in %LOCALAPPDATA%\\hermes on Windows, ~/.hermes elsewhere, HERMES_HOME wins", () => {
    assert.strictEqual(
      hermesHome("C:\\Users\\me", "win32", {}),
      "C:\\Users\\me\\AppData\\Local\\hermes",
    );
    assert.strictEqual(hermesHome("/home/me", "linux", {}), "/home/me/.hermes");
    assert.strictEqual(
      hermesHome("/home/me", "linux", { HERMES_HOME: "/opt/h" }),
      "/opt/h",
    );
  });

  test("adds provider, keeps model block and comments, idempotent", () => {
    const before =
      "# top\nmodel:\n  default: gpt\n  provider: openrouter\nproviders:\n  other:\n    api: http://x\n";
    const plan = hermesAdapter.plan(input, { [HM]: before });
    const after = plan.changes.find((c) => c.path === HM)!.after!;
    const backupAfter = plan.changes.find((c) => c.path === HB)!.after!;
    assert.ok(after.includes("# top"));
    const v = parseYaml(after);
    assert.deepStrictEqual(v.model, {
      default: "claude-sonnet-4.5",
      provider: "agent-gateway",
      context_length: 200000,
    });
    assert.strictEqual(v.providers.other.api, "http://x");
    assert.deepStrictEqual(v.providers["agent-gateway"], {
      api: "http://127.0.0.1:24444/v1",
      api_key: PLACEHOLDER_API_KEY,
      transport: "chat_completions",
      default_model: "claude-sonnet-4.5",
      discover_models: true,
      models: { "claude-sonnet-4.5": { context_length: 200000 } },
    });
    assert.strictEqual(
      hermesAdapter.plan(input, { [HM]: after, [HB]: backupAfter }).changes
        .length,
      0,
    );
    const reverted = hermesAdapter.unplan(input, {
      [HM]: after,
      [HB]: backupAfter,
    }).changes[0].after!;
    assert.strictEqual(reverted, before);
    assert.strictEqual(
      hermesAdapter.unplan(input, { [HM]: after, [HB]: backupAfter }).changes[1]
        .after,
      undefined,
    );
  });

  test("converts and restores scalar model settings", () => {
    for (const scalar of ["", "openrouter/old-model"]) {
      const before = `# scalar\nmodel: ${JSON.stringify(scalar)}\n`;
      const plan = hermesAdapter.plan(input, { [HM]: before });
      const after = plan.changes.find((c) => c.path === HM)!.after!;
      const backupAfter = plan.changes.find((c) => c.path === HB)!.after!;
      assert.deepStrictEqual(parseYaml(after).model, {
        provider: "agent-gateway",
        default: input.defaultModel,
        context_length: 200000,
      });
      assert.strictEqual(JSON.parse(backupAfter).scalarModel, scalar);
      const reverted = hermesAdapter
        .unplan(input, { [HM]: after, [HB]: backupAfter })
        .changes.find((c) => c.path === HM)!.after!;
      assert.strictEqual(reverted, before);
    }
  });

  test("scalar restoration keeps model settings added after configuration", () => {
    const plan = hermesAdapter.plan(input, {
      [HM]: 'model: "openrouter/old-model"\n',
    });
    const current = plan.changes
      .find((c) => c.path === HM)!
      .after!.replace(
        "  context_length: 200000\n",
        "  context_length: 200000\n  temperature: 0.5\n",
      );
    const restored = hermesAdapter
      .unplan(input, {
        [HM]: current,
        [HB]: plan.changes.find((c) => c.path === HB)?.after,
      })
      .changes.find((c) => c.path === HM)!.after!;
    assert.deepStrictEqual(parseYaml(restored).model, {
      temperature: 0.5,
      default: "openrouter/old-model",
    });
  });

  test("reconfigure keeps Hermes's original default and unrelated model options", () => {
    const before =
      "model:\n  provider: openrouter\n  default: old\n  context_length: 1000000\n  temperature: 0.5\n";
    const first = hermesAdapter.plan(input, { [HM]: before });
    const updated = hermesAdapter
      .plan(
        { ...input, defaultModel: "another" },
        {
          [HM]: first.changes.find((c) => c.path === HM)?.after,
          [HB]: first.changes.find((c) => c.path === HB)?.after,
        },
      )
      .changes.find((c) => c.path === HM)!.after!;
    assert.strictEqual(parseYaml(updated).model.default, "another");
    assert.strictEqual(parseYaml(updated).model.context_length, undefined);
    const restored = hermesAdapter
      .unplan(input, {
        [HM]: updated,
        [HB]: first.changes.find((c) => c.path === HB)?.after,
      })
      .changes.find((c) => c.path === HM)!.after!;
    assert.deepStrictEqual(parseYaml(restored).model, parseYaml(before).model);
  });

  test("restores Hermes's default after the provider entry is removed elsewhere", () => {
    const before = "model:\n  provider: openrouter\n  default: old\n";
    const plan = hermesAdapter.plan(input, { [HM]: before });
    const withoutProvider =
      "model:\n  provider: agent-gateway\n  default: claude-sonnet-4.5\n";
    const changes = hermesAdapter.unplan(input, {
      [HM]: withoutProvider,
      [HB]: plan.changes.find((c) => c.path === HB)?.after,
    }).changes;
    assert.deepStrictEqual(
      parseYaml(changes[0].after!).model,
      parseYaml(before).model,
    );
    assert.strictEqual(changes[1].after, undefined);
  });

  test("restores Hermes's custom provider alias and handles legacy removal", () => {
    const before = "model:\n  provider: openrouter\n  default: old\n";
    const plan = hermesAdapter.plan(input, { [HM]: before });
    const current = plan.changes
      .find((c) => c.path === HM)!
      .after!.replace(
        "provider: agent-gateway",
        "provider: custom:agent-gateway",
      );
    const legacy = hermesAdapter.unplan(input, { [HM]: current });
    assert.strictEqual(
      parseYaml(legacy.changes.find((c) => c.path === HM)!.after!).model
        ?.provider,
      undefined,
    );
    const restored = hermesAdapter
      .unplan(input, {
        [HM]: current,
        [HB]: plan.changes.find((c) => c.path === HB)?.after,
      })
      .changes.find((c) => c.path === HM)!.after!;
    assert.deepStrictEqual(parseYaml(restored).model, parseYaml(before).model);
  });

  test("upgrades a legacy gateway default without inventing a previous provider", () => {
    const legacy = "model:\n  provider: agent-gateway\n  default: old\n";
    const updated = hermesAdapter.plan(input, { [HM]: legacy });
    const backupAfter = updated.changes.find((c) => c.path === HB)!.after!;
    assert.deepStrictEqual(JSON.parse(backupAfter), {
      provider: null,
      model: null,
      context: null,
      legacy: true,
    });
    const current = updated.changes.find((c) => c.path === HM)!.after!;
    assert.strictEqual(parseYaml(current).model.default, input.defaultModel);
  });

  test("restores a legacy Hermes context override without an earlier model", () => {
    const before =
      "model:\n  provider: agent-gateway\n  default: old\n  context_length: 900000\n";
    const updated = hermesAdapter.plan(input, { [HM]: before });
    const current = updated.changes.find((c) => c.path === HM)!.after!;
    const backupAfter = updated.changes.find((c) => c.path === HB)!.after!;
    assert.strictEqual(parseYaml(current).model.context_length, 200000);
    const removed = hermesAdapter.unplan(input, {
      [HM]: current,
      [HB]: backupAfter,
    });
    const model = parseYaml(
      removed.changes.find((c) => c.path === HM)!.after!,
    ).model;
    assert.strictEqual(model.provider, undefined);
    assert.strictEqual(model.default, undefined);
    assert.strictEqual(model.context_length, 900000);
  });

  test("does not reformat unrelated YAML on removal", () => {
    const before = "model: {provider: openrouter, default: old}\n";
    assert.deepStrictEqual(
      hermesAdapter.unplan(input, { [HM]: before }).changes,
      [],
    );
  });

  test("keeps the backup when config.yaml is missing during removal", () => {
    const plan = hermesAdapter.plan(input, {
      [HM]: "model: openrouter/old-model\n",
    });
    const backupAfter = plan.changes.find((c) => c.path === HB)!.after!;
    const removal = hermesAdapter.unplan(input, { [HB]: backupAfter });
    assert.deepStrictEqual(removal.changes, []);
    assert.ok(removal.summary.some((line) => line.includes("kept")));
    assert.ok(removal.manualSteps?.some((line) => line.includes(HM)));
  });

  test("removal accepts a valid scalar model setting", () => {
    const before =
      'model: "user/selected-model"\nproviders:\n  agent-gateway:\n    api: http://127.0.0.1:24444/v1\n';
    const removal = hermesAdapter.unplan(input, { [HM]: before });
    const after = removal.changes.find((c) => c.path === HM)!.after!;
    assert.strictEqual(parseYaml(after).model, "user/selected-model");
    assert.strictEqual(parseYaml(after).providers, undefined);
  });

  test("rejects malformed model settings instead of discarding the backup", () => {
    const plan = hermesAdapter.plan(input, {});
    assert.throws(
      () =>
        hermesAdapter.unplan(input, {
          [HM]: "model: []\n",
          [HB]: plan.changes.find((c) => c.path === HB)?.after,
        }),
      /model must be a mapping/,
    );
  });

  test("new file and unplan drops empty providers", () => {
    const plan = hermesAdapter.plan({ ...input, apiKey: "k" }, {});
    assert.ok(plan.summary.some((s) => s.includes("model.provider")));
    const after = plan.changes.find((c) => c.path === HM)!.after!;
    assert.strictEqual(parseYaml(after).model.context_length, 200000);
    assert.strictEqual(
      parseYaml(after).providers["agent-gateway"].api_key,
      "k",
    );
    const reverted = hermesAdapter
      .unplan(input, {
        [HM]: after,
        [HB]: plan.changes.find((c) => c.path === HB)?.after,
      })
      .changes.find((c) => c.path === HM)!.after!;
    assert.strictEqual(parseYaml(reverted)?.providers, undefined);
  });
});
