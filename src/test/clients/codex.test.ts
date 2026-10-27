import * as assert from "assert";

import { codexAdapter, planCodexWebSearch } from "../../clients/codex";
import { ClientConfigInput, PLACEHOLDER_API_KEY } from "../../clients/types";

const HOME = "C:\\Users\\me";
const FILE = "C:\\Users\\me\\.codex\\config.toml";

const input: ClientConfigInput = {
  gatewayUrl: "http://127.0.0.1:24444",
  models: [],
  defaultModel: "gpt-5.1",
  home: HOME,
  platform: "win32",
};

const OTHER_PROVIDER = [
  "[model_providers.other-proxy]",
  'name = "Other Proxy"',
  'base_url = "http://localhost:8080/api/openai/v1"',
  'wire_api = "responses"',
].join("\n");

const MCP = [
  "[mcp_servers.x]",
  'command = "npx"',
  'args = ["-y", "x-server"]',
  "",
  "[mcp_servers.x.env]",
  'TOKEN = "abc" # keep me',
].join("\n");

const EXISTING = [
  "# my codex config",
  'model = "gpt-5" # favourite',
  'model_provider = "other-proxy"',
  "model_context_window = 271805",
  "notify = [",
  '  "powershell",',
  '  "-File", "[notify].ps1",',
  "]",
  "",
  OTHER_PROVIDER,
  "",
  MCP,
  "",
].join("\n");

function apply(
  text: string | undefined,
  fn: "plan" | "unplan",
  inp = input,
): string | undefined {
  const file = codexAdapter.configPaths(inp.home, inp.platform)[0];
  const plan = codexAdapter[fn](inp, { [file]: text });
  return plan.changes.length ? plan.changes[0].after : text;
}

suite("Codex adapter", () => {
  test("paths use win32 home", () => {
    assert.deepStrictEqual(codexAdapter.configPaths(HOME, "win32"), [FILE]);
    assert.deepStrictEqual(codexAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.codex/config.toml",
    ]);
  });

  test("new file", () => {
    const out = apply(undefined, "plan")!;
    assert.strictEqual(
      out,
      [
        "features.api_key_model_discovery = true",
        'model_provider = "agent-gateway"',
        'model = "gpt-5.1"',
        "",
        "[model_providers.agent-gateway]",
        "# agent-gateway previous: model_provider=<unset>, model=<unset>",
        "# agent-gateway previous provider catalog: <unset>",
        "# agent-gateway previous feature: api_key_model_discovery=<unset>",
        'name = "Agent Gateway"',
        'base_url = "http://127.0.0.1:24444/v1"',
        'model_catalog_url = "http://127.0.0.1:24444/v1/models"',
        'wire_api = "responses"',
        `experimental_bearer_token = "${PLACEHOLDER_API_KEY}"`,
        "",
      ].join("\n"),
    );
  });

  test("new file unplan deletes keys", () => {
    const out = apply(apply(undefined, "plan"), "unplan")!;
    assert.strictEqual(out.trim(), "");
  });

  test("existing file: keys replaced in place, other tables byte-for-byte", () => {
    const plan = codexAdapter.plan(
      { ...input, apiKey: "secret-key" },
      { [FILE]: EXISTING },
    );
    const out = plan.changes[0].after!;
    assert.ok(
      out.includes(
        '# my codex config\nmodel = "gpt-5.1"\nmodel_provider = "agent-gateway"\n',
      ),
    );
    assert.ok(out.includes(OTHER_PROVIDER));
    assert.ok(out.includes(MCP));
    assert.ok(
      out.includes(
        'notify = [\n  "powershell",\n  "-File", "[notify].ps1",\n]',
      ),
    );
    assert.ok(out.includes("model_context_window = 271805"));
    assert.ok(out.includes('experimental_bearer_token = "secret-key"'));
    assert.ok(
      out.includes('previous: model_provider="other-proxy", model="gpt-5"'),
    );
    assert.ok(!plan.summary.join(" ").includes("secret-key"));
    assert.ok(out.indexOf("model_provider") < out.indexOf("["));
  });

  test("idempotent", () => {
    const once = apply(EXISTING, "plan")!;
    const plan = codexAdapter.plan(input, { [FILE]: once });
    assert.strictEqual(plan.changes.length, 0);
    assert.strictEqual(once.split("[model_providers.agent-gateway]").length, 2);
    // Changing the model keeps the original "previous" record.
    const again = apply(once, "plan", { ...input, defaultModel: "claude-x" })!;
    assert.ok(
      again.includes('previous: model_provider="other-proxy", model="gpt-5"'),
    );
    assert.ok(again.includes('model = "claude-x"'));
  });

  test("unplan restores previous values and file", () => {
    const out = apply(apply(EXISTING, "plan"), "unplan")!;
    assert.strictEqual(
      out,
      EXISTING.replace('model = "gpt-5" # favourite', 'model = "gpt-5"'),
    );
  });

  test("unplan without marker leaves model_provider unset", () => {
    const text =
      'model_provider = "agent-gateway"\nmodel = "m"\n\n' +
      OTHER_PROVIDER +
      "\n";
    const plan = codexAdapter.unplan(input, { [FILE]: text });
    assert.strictEqual(
      plan.changes[0].after,
      'model = "m"\n\n' + OTHER_PROVIDER + "\n",
    );
  });

  test("existing table in the middle is replaced; CRLF preserved", () => {
    const text = [
      'model = "a"',
      "",
      "[model_providers.agent-gateway]",
      'base_url = "http://old/v1"',
      "",
      OTHER_PROVIDER.replace(/\n/g, "\r\n"),
      "",
    ].join("\r\n");
    const out = apply(text, "plan")!;
    assert.ok(
      out.includes(
        `experimental_bearer_token = "${PLACEHOLDER_API_KEY}"\r\n\r\n[model_providers.other-proxy]`,
      ),
    );
    assert.ok(!out.includes("http://old"));
    const back = apply(out, "unplan")!;
    assert.strictEqual(
      back,
      text.replace(
        /\r\n\[model_providers\.agent-gateway\]\r\nbase_url = "http:\/\/old\/v1"\r\n/,
        "",
      ),
    );
  });

  test("discovery URL follows gateway port changes and restores the original catalog", () => {
    const text = 'model_catalog_url = "https://example.test/models"\n' + EXISTING;
    const once = apply(text, "plan")!;
    const changed = { ...input, gatewayUrl: "http://127.0.0.1:24445/" };
    const twice = apply(once, "plan", changed)!;
    assert.ok(twice.includes('model_catalog_url = "http://127.0.0.1:24445/v1/models"'));
    const sections = twice.split(/(?=^\[)/m);
    assert.ok(!sections[0].includes('model_catalog_url = "http://127.0.0.1:24445'));
    const provider = sections.find((section) => section.startsWith("[model_providers.agent-gateway]"))!;
    const catalog = /^model_catalog_url\s*=\s*(.*)$/m.exec(provider)!;
    assert.strictEqual(JSON.parse(catalog[1]), "http://127.0.0.1:24445/v1/models");
    assert.ok(sections[0].includes('model_catalog_url = "https://example.test/models"'));
    assert.ok(twice.includes('base_url = "http://127.0.0.1:24445/v1"'));
    assert.ok(!twice.includes("24444"));
    assert.strictEqual(apply(twice, "plan", changed), twice);
    assert.strictEqual(
      apply(twice, "unplan", changed),
      text.replace('model = "gpt-5" # favourite', 'model = "gpt-5"'),
    );
  });

  test("restores a preexisting provider catalog and removes owned provider fields", () => {
    const text = EXISTING + '\n[model_providers.agent-gateway]\nmodel_catalog_url = "https://example.test/provider-models"\n';
    const out = apply(text, "plan")!;
    assert.ok(out.includes('# agent-gateway previous provider catalog: "https://example.test/provider-models"'));
    assert.strictEqual(apply(out, "plan"), out);
    const restored = apply(out, "unplan")!;
    assert.ok(restored.includes('[model_providers.agent-gateway]\nmodel_catalog_url = "https://example.test/provider-models"'));
    assert.ok(!restored.includes("experimental_bearer_token"));
    assert.ok(!restored.includes("agent-gateway previous"));
    assert.ok(restored.includes(OTHER_PROVIDER));
  });

  test("macOS migrates an older gateway marker and restores existing feature values", () => {
    const mac = { ...input, home: "/home/me", platform: "darwin" as const };
    const text = [
      'model_provider = "agent-gateway"',
      'model = "gateway-old"',
      "",
      '["features"] # keep this header',
      '"api_key_model_discovery" = false',
      "respect_system_proxy = false",
      "shell_tool = true # unrelated",
      "",
      "[model_providers.agent-gateway]",
      '# agent-gateway previous: model_provider="other-proxy", model="gpt-5"',
      'base_url = "http://old/v1"',
      "",
      OTHER_PROVIDER.replace(/\n/g, "\r\n"),
      "",
    ].join("\r\n");
    const out = apply(text, "plan", mac)!;
    assert.ok(out.includes('"api_key_model_discovery" = true\r\nrespect_system_proxy = true'));
    assert.ok(out.includes('previous feature: api_key_model_discovery=false'));
    assert.ok(out.includes('previous feature: respect_system_proxy=false'));
    assert.ok(out.includes('shell_tool = true # unrelated'));
    assert.ok(!/[^\r]\n/.test(out));
    assert.strictEqual(apply(out, "plan", mac), out);
    const restored = apply(out, "unplan", mac)!;
    assert.ok(restored.includes('model_provider = "other-proxy"'));
    assert.ok(restored.includes('model = "gpt-5"'));
    assert.ok(restored.includes('["features"] # keep this header\r\n"api_key_model_discovery" = false\r\nrespect_system_proxy = false\r\nshell_tool = true # unrelated'));
    assert.ok(!restored.includes("model_catalog_url"));
    assert.ok(!restored.includes("agent-gateway previous"));
    assert.ok(restored.includes(OTHER_PROVIDER.replace(/\n/g, "\r\n")));
  });

  test("existing enabled dotted features are preserved and restored without duplicate keys", () => {
    const mac = { ...input, home: "/home/me", platform: "darwin" as const };
    const features = [
      'features."api_key_model_discovery" = true # already enabled',
      "features.respect_system_proxy = true # user preference",
      "features.shell_tool = false # unrelated",
      "",
    ].join("\n");
    const text = features + EXISTING;
    const out = apply(text, "plan", mac)!;
    assert.ok(out.includes(features));
    assert.strictEqual((out.match(/^features\."?api_key_model_discovery"?\s*=/gm) ?? []).length, 1);
    assert.strictEqual((out.match(/^features\.respect_system_proxy\s*=/gm) ?? []).length, 1);
    assert.strictEqual(apply(out, "plan", mac), out);
    assert.strictEqual(
      apply(out, "unplan", mac),
      text.replace('model = "gpt-5" # favourite', 'model = "gpt-5"'),
    );
  });

  test("macOS removes inserted feature keys but preserves the user's feature table", () => {
    const mac = { ...input, home: "/home/me", platform: "darwin" as const };
    const text = EXISTING + "\n[features]\nshell_tool = true # keep\n";
    const out = apply(text, "plan", mac)!;
    assert.ok(out.includes("api_key_model_discovery = true"));
    assert.ok(out.includes("respect_system_proxy = true"));
    assert.ok(!out.includes("features.api_key_model_discovery"));
    assert.strictEqual(apply(out, "plan", mac), out);
    assert.strictEqual(
      apply(out, "unplan", mac),
      text.replace('model = "gpt-5" # favourite', 'model = "gpt-5"'),
    );
  });

  for (const platform of ["linux", "win32"] as const) {
    test(`${platform} leaves native proxy preferences untouched`, () => {
      const current = { ...input, platform, home: platform === "win32" ? HOME : "/home/me" };
      const text = EXISTING + "\n[features]\nrespect_system_proxy = false # keep\nshell_tool = true\n";
      const out = apply(text, "plan", current)!;
      assert.ok(out.includes("api_key_model_discovery = true"));
      assert.ok(out.includes("respect_system_proxy = false # keep"));
      assert.ok(!out.includes("previous feature: respect_system_proxy"));
      assert.strictEqual(apply(out, "plan", current), out);
      assert.strictEqual(
        apply(out, "unplan", current),
        text.replace('model = "gpt-5" # favourite', 'model = "gpt-5"'),
      );
      assert.ok(!apply(undefined, "plan", current)!.includes("respect_system_proxy"));
    });
  }
});

suite("Codex web_search sync", () => {
  const apply = (text: string, enable: boolean) => {
    const plan = planCodexWebSearch(HOME, "win32", { [FILE]: text }, enable);
    return plan.changes.length ? (plan.changes[0].after ?? "") : text;
  };
  const BASE = ['model = "gpt-5.5"', "", OTHER_PROVIDER, ""].join("\n");

  test("enable sets live and disable restores an unset key exactly", () => {
    const on = apply(BASE, true);
    assert.match(
      on,
      /^# agent-gateway previous web_search: <unset>\nweb_search = "live"\n/,
    );
    assert.ok(on.includes(OTHER_PROVIDER));
    assert.strictEqual(apply(on, true), on, "enable is idempotent");
    assert.strictEqual(apply(on, false), BASE);
  });

  test("an existing value is recorded and restored", () => {
    const text = [
      'web_search = "cached"',
      'model = "gpt-5.5"',
      "",
      OTHER_PROVIDER,
      "",
    ].join("\n");
    const on = apply(text, true);
    assert.ok(on.includes('# agent-gateway previous web_search: "cached"'));
    assert.ok(on.includes('web_search = "live"'));
    assert.ok(!on.includes('web_search = "cached"'));
    assert.strictEqual(apply(on, false), text);
  });

  test("a user-set live value is left alone in both directions", () => {
    const text = ['web_search = "live"', "", OTHER_PROVIDER, ""].join("\n");
    assert.strictEqual(apply(text, true), text);
    assert.strictEqual(apply(text, false), text);
  });

  test("a missing config file is not created", () => {
    const plan = planCodexWebSearch(HOME, "win32", { [FILE]: undefined }, true);
    assert.deepStrictEqual(plan.changes, []);
  });

  test("CRLF files keep CRLF", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const on = apply(crlf, true);
    assert.ok(!/[^\r]\n/.test(on));
    assert.strictEqual(apply(on, false), crlf);
  });
});
