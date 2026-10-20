import * as assert from "assert";

import { antigravityAdapter } from "../../clients/antigravity";
import { ClientConfigInput, PLACEHOLDER_API_KEY } from "../../clients/types";

const SETTINGS = "C:\\Users\\me\\.gemini\\antigravity-cli\\settings.json";

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444",
    models: [
      {
        id: "gemini-3.8-flash",
        displayName: "F",
        contextWindow: 1000000,
        inputModalities: ["text"],
        supportsToolCalling: true,
        reasoning: true,
      },
    ],
    defaultModel: "gemini-3.8-flash",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

suite("antigravity adapter", () => {
  test("creates settings.json with the Gemini provider", () => {
    const p = antigravityAdapter.plan(input(), {});
    assert.strictEqual(p.changes.length, 1);
    assert.strictEqual(p.changes[0].path, SETTINGS);
    assert.deepStrictEqual(JSON.parse(p.changes[0].after!), {
      modelProvider: "gemini",
    });
    assert.ok(
      p.clipboard!.includes(
        "setx GOOGLE_GEMINI_BASE_URL http://127.0.0.1:24444",
      ),
    );
    assert.ok(
      p.clipboard!.includes(`setx GEMINI_API_KEY ${PLACEHOLDER_API_KEY}`),
    );
  });

  test("keeps comments and other settings, and is idempotent", () => {
    const before =
      '{\n  // mine\n  "trustedWorkspaces": ["/w"],\n  "modelProvider": "google",\n}\n';
    const p = antigravityAdapter.plan(input(), { [SETTINGS]: before });
    const after = p.changes[0].after!;
    assert.ok(after.includes("// mine"));
    assert.ok(after.includes('"trustedWorkspaces"'));
    assert.ok(after.includes('"modelProvider": "gemini"'));
    assert.deepStrictEqual(
      antigravityAdapter.plan(input(), { [SETTINGS]: after }).changes,
      [],
    );
  });

  test("unplan removes only modelProvider", () => {
    const before =
      '{\n  // mine\n  "verbosity": "low",\n  "modelProvider": "gemini"\n}\n';
    const u = antigravityAdapter.unplan(input(), { [SETTINGS]: before });
    const after = u.changes[0].after!;
    assert.ok(after.includes("// mine"));
    assert.ok(after.includes('"verbosity": "low"'));
    assert.ok(!after.includes("modelProvider"));
    assert.deepStrictEqual(
      antigravityAdapter.unplan(input(), { [SETTINGS]: after }).changes,
      [],
    );
    assert.deepStrictEqual(antigravityAdapter.unplan(input(), {}).changes, []);
  });

  test("uses export on POSIX and does not leak the key", () => {
    const p = antigravityAdapter.plan(
      input({ home: "/home/me", platform: "linux", apiKey: "secret" }),
      {},
    );
    assert.strictEqual(
      p.changes[0].path,
      "/home/me/.gemini/antigravity-cli/settings.json",
    );
    assert.ok(p.clipboard!.includes("export GOOGLE_GEMINI_BASE_URL="));
    assert.ok(!JSON.stringify(p).includes("secret"));
  });

  test("rejects invalid JSON", () => {
    assert.throws(() =>
      antigravityAdapter.plan(input(), { [SETTINGS]: "{ nope" }),
    );
  });
});
