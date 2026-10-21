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
    const after = hermesAdapter.plan(input, { [HM]: before }).changes[0].after!;
    assert.ok(after.includes("# top"));
    const v = parseYaml(after);
    assert.deepStrictEqual(v.model, { default: "gpt", provider: "openrouter" });
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
      hermesAdapter.plan(input, { [HM]: after }).changes.length,
      0,
    );
    const reverted = hermesAdapter.unplan(input, { [HM]: after }).changes[0]
      .after!;
    assert.strictEqual(reverted, before);
  });

  test("new file and unplan drops empty providers", () => {
    const plan = hermesAdapter.plan({ ...input, apiKey: "k" }, {});
    assert.ok(plan.summary.some((s) => s.includes("hermes model")));
    const after = plan.changes[0].after!;
    assert.strictEqual(
      parseYaml(after).providers["agent-gateway"].api_key,
      "k",
    );
    const reverted = hermesAdapter.unplan(input, { [HM]: after }).changes[0]
      .after!;
    assert.strictEqual(parseYaml(reverted)?.providers, undefined);
  });
});
