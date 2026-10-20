import * as assert from "assert";

import { clineAdapter } from "../../clients/cline";
import {
  type ClientConfigInput,
  PLACEHOLDER_API_KEY,
} from "../../clients/types";

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444/",
    models: [],
    defaultModel: "claude-sonnet",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

const target = "C:\\Users\\me\\.cline\\data\\settings\\providers.json";

const existing = JSON.stringify(
  {
    version: 1,
    lastUsedProvider: "anthropic",
    modes: { act: "anthropic" },
    providers: {
      anthropic: {
        settings: { provider: "anthropic", apiKey: "sk-user", model: "x" },
        updatedAt: "2026-01-01T00:00:00.000Z",
        tokenSource: "manual",
      },
    },
  },
  null,
  2,
);

suite("clients/cline", () => {
  test("paths", () => {
    assert.deepStrictEqual(clineAdapter.configPaths("C:\\Users\\me", "win32"), [
      target,
    ]);
    assert.deepStrictEqual(clineAdapter.detectPaths("/home/me", "linux"), [
      "/home/me/.cline",
    ]);
  });

  test("creates providers.json", () => {
    const plan = clineAdapter.plan(input(), {});
    assert.strictEqual(plan.changes.length, 1);
    const file = JSON.parse(plan.changes[0].after!);
    assert.strictEqual(file.version, 1);
    assert.strictEqual(file.lastUsedProvider, "openai-compatible");
    assert.deepStrictEqual(file.providers["openai-compatible"].settings, {
      provider: "openai-compatible",
      apiKey: PLACEHOLDER_API_KEY,
      model: "claude-sonnet",
      baseUrl: "http://127.0.0.1:24444/v1",
    });
    assert.strictEqual(
      file.providers["openai-compatible"].tokenSource,
      "manual",
    );
  });

  test("preserves other providers and uses the api key", () => {
    const plan = clineAdapter.plan(input({ apiKey: "gw-key" }), {
      [target]: existing,
    });
    const file = JSON.parse(plan.changes[0].after!);
    assert.strictEqual(file.providers.anthropic.settings.apiKey, "sk-user");
    assert.deepStrictEqual(file.modes, { act: "anthropic" });
    assert.strictEqual(
      file.providers["openai-compatible"].settings.apiKey,
      "gw-key",
    );
  });

  test("plan is idempotent", () => {
    const first = clineAdapter.plan(input(), { [target]: existing });
    const second = clineAdapter.plan(input(), {
      [target]: first.changes[0].after,
    });
    assert.deepStrictEqual(second.changes, []);
  });

  test("warns when replacing a foreign openai-compatible entry", () => {
    const foreign = JSON.stringify({
      version: 1,
      providers: {
        "openai-compatible": {
          settings: { provider: "openai-compatible", baseUrl: "https://x/v1" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const plan = clineAdapter.plan(input(), { [target]: foreign });
    assert.ok(plan.summary.some((s) => s.includes("https://x/v1")));
  });

  test("rejects unknown files", () => {
    assert.throws(() => clineAdapter.plan(input(), { [target]: "{" }));
    assert.throws(() =>
      clineAdapter.plan(input(), { [target]: '{"version":2}' }),
    );
  });

  test("unplan restores other providers", () => {
    const applied = clineAdapter.plan(input(), { [target]: existing })
      .changes[0].after!;
    const revert = clineAdapter.unplan(input(), { [target]: applied });
    const file = JSON.parse(revert.changes[0].after!);
    assert.deepStrictEqual(Object.keys(file.providers), ["anthropic"]);
    assert.strictEqual(file.lastUsedProvider, "anthropic");
    const again = clineAdapter.unplan(input(), {
      [target]: revert.changes[0].after,
    });
    assert.deepStrictEqual(again.changes, []);
  });

  test("unplan leaves a foreign openai-compatible entry", () => {
    const other = clineAdapter.plan(input({ gatewayUrl: "http://other:1" }), {})
      .changes[0].after!;
    assert.deepStrictEqual(
      clineAdapter.unplan(input(), { [target]: other }).changes,
      [],
    );
    assert.deepStrictEqual(clineAdapter.unplan(input(), {}).changes, []);
  });
});
