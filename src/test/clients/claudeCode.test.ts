import * as assert from "assert";
import { parse } from "jsonc-parser";

import { claudeCodeAdapter } from "../../clients/claudeCode";
import {
  ClientConfigInput,
  ClientPlan,
  PLACEHOLDER_API_KEY,
} from "../../clients/types";

const HOME = "C:\\Users\\me";
const FILE = "C:\\Users\\me\\.claude\\settings.json";

const input: ClientConfigInput = {
  gatewayUrl: "http://127.0.0.1:24444",
  models: [],
  defaultModel: "claude-sonnet-4.5",
  home: HOME,
  platform: "win32",
};

const realistic = `{
  // user settings
  "permissions": {
    "allow": ["Bash(git status)", "Read(*)"],
    "deny": []
  },
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }]
  },
  "env": {
    "DISABLE_TELEMETRY": "1",
    "ANTHROPIC_MODEL": "opus"
  },
  "theme": "dark"
}
`;

function after(p: ClientPlan): string {
  return p.changes[0].after as string;
}

suite("claudeCodeAdapter", () => {
  test("paths use platform home", () => {
    assert.deepStrictEqual(claudeCodeAdapter.configPaths(HOME, "win32"), [
      FILE,
    ]);
    assert.deepStrictEqual(claudeCodeAdapter.configPaths("/home/u", "linux"), [
      "/home/u/.claude/settings.json",
    ]);
  });

  test("plan sets env keys and preserves others and comments", () => {
    const text = after(claudeCodeAdapter.plan(input, { [FILE]: realistic }));
    const obj = parse(text);
    assert.strictEqual(obj.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:24444");
    assert.strictEqual(obj.env.ANTHROPIC_AUTH_TOKEN, PLACEHOLDER_API_KEY);
    assert.strictEqual(obj.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.strictEqual(obj.env.ANTHROPIC_MODEL, "claude-sonnet-4.5");
    assert.strictEqual(obj.env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
    assert.strictEqual(obj.env.DISABLE_TELEMETRY, "1");
    assert.deepStrictEqual(obj.permissions.allow, [
      "Bash(git status)",
      "Read(*)",
    ]);
    assert.strictEqual(obj.hooks.Stop[0].hooks[0].command, "echo done");
    assert.strictEqual(obj.theme, "dark");
    assert.ok(text.includes("// user settings"));
    assert.deepStrictEqual(JSON.parse(obj.env.AGENT_GATEWAY_PREVIOUS), {
      ANTHROPIC_BASE_URL: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: null,
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_AUTO_MODE_SERVER: null,
    });
  });

  test("uses apiKey when given", () => {
    const obj = parse(
      after(
        claudeCodeAdapter.plan(
          { ...input, apiKey: "k1" },
          { [FILE]: realistic },
        ),
      ),
    );
    assert.strictEqual(obj.env.ANTHROPIC_AUTH_TOKEN, "k1");
  });

  test("idempotent", () => {
    const once = after(claudeCodeAdapter.plan(input, { [FILE]: realistic }));
    assert.strictEqual(
      claudeCodeAdapter.plan(input, { [FILE]: once }).changes.length,
      0,
    );
  });

  test("unplan restores previous values exactly", () => {
    const once = after(claudeCodeAdapter.plan(input, { [FILE]: realistic }));
    const back = after(claudeCodeAdapter.unplan(input, { [FILE]: once }));
    assert.deepStrictEqual(parse(back), parse(realistic));
    assert.ok(back.includes("// user settings"));
  });

  test("missing file is created; unplan removes keys", () => {
    const text = after(claudeCodeAdapter.plan(input, { [FILE]: undefined }));
    assert.strictEqual(parse(text).env.AGENT_GATEWAY_PREVIOUS, undefined);
    const back = after(claudeCodeAdapter.unplan(input, { [FILE]: text }));
    assert.deepStrictEqual(parse(back), { env: {} });
  });

  test("unplan keeps user-owned keys that already matched the gateway", () => {
    const owned = JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: input.gatewayUrl,
          ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_API_KEY,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
          ANTHROPIC_MODEL: input.defaultModel,
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
          MCP_TIMEOUT: "60000",
        },
      },
      null,
      2,
    );
    const once = after(claudeCodeAdapter.plan(input, { [FILE]: owned }));
    assert.strictEqual(
      claudeCodeAdapter.plan(input, { [FILE]: once }).changes.length,
      0,
    );
    const back = after(claudeCodeAdapter.unplan(input, { [FILE]: once }));
    assert.deepStrictEqual(parse(back), parse(owned));
  });

  test("summary mentions gateway model cache", () => {
    const p = claudeCodeAdapter.plan(input, { [FILE]: realistic });
    assert.ok(
      p.summary.some((s) =>
        s.includes("C:\\Users\\me\\.claude\\cache\\gateway-models.json"),
      ),
    );
  });

  test("invalid JSON throws", () => {
    assert.throws(() => claudeCodeAdapter.plan(input, { [FILE]: "{ nope" }));
  });
});
