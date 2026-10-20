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
  const plan = codexAdapter[fn](inp, { [FILE]: text });
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
        'model_provider = "agent-gateway"',
        'model = "gpt-5.1"',
        "",
        "[model_providers.agent-gateway]",
        "# agent-gateway previous: model_provider=<unset>, model=<unset>",
        'name = "Agent Gateway"',
        'base_url = "http://127.0.0.1:24444/v1"',
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
      out.startsWith(
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
    assert.ok(plan.summary.some((s) => s.includes("model_context_window")));
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
    assert.ok(plan.summary.some((s) => s.includes("unknown")));
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
