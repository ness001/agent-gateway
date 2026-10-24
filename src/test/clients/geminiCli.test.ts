import { parse } from "jsonc-parser";
import * as assert from "node:assert";

import { geminiCliAdapter, geminiCliDir } from "../../clients/geminiCli";
import {
  ClientConfigInput,
  ClientPlan,
  PLACEHOLDER_API_KEY,
} from "../../clients/types";

const input: ClientConfigInput = {
  gatewayUrl: "http://127.0.0.1:24444",
  models: [],
  defaultModel: "gemini-3.8-flash",
  home: "/home/u",
  platform: "linux",
};
const ENV = "/home/u/.gemini/.env";
const SETTINGS = "/home/u/.gemini/settings.json";
const BACKUP = "/home/u/.gemini/agent-gateway.json";
type Files = Record<string, string | undefined>;

function apply(files: Files, plan: ClientPlan): Files {
  return {
    ...files,
    ...Object.fromEntries(plan.changes.map((c) => [c.path, c.after])),
  };
}

suite("geminiCliAdapter", () => {
  let oldHome: string | undefined;
  setup(() => {
    oldHome = process.env.GEMINI_CLI_HOME;
    delete process.env.GEMINI_CLI_HOME;
  });
  teardown(() => {
    if (oldHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = oldHome;
    }
  });

  test("paths use home on every platform and honor GEMINI_CLI_HOME", () => {
    assert.strictEqual(geminiCliDir("/home/u", "linux", {}), "/home/u/.gemini");
    assert.strictEqual(
      geminiCliDir("/Users/u", "darwin", {}),
      "/Users/u/.gemini",
    );
    assert.strictEqual(
      geminiCliDir("C:\\Users\\u", "win32", {}),
      "C:\\Users\\u\\.gemini",
    );
    assert.strictEqual(
      geminiCliDir("/home/u", "linux", { GEMINI_CLI_HOME: "/custom" }),
      "/custom/.gemini",
    );
    process.env.GEMINI_CLI_HOME = "C:\\custom";
    assert.deepStrictEqual(
      geminiCliAdapter.configPaths("C:\\Users\\u", "win32"),
      [
        "C:\\custom\\.gemini\\.env",
        "C:\\custom\\.gemini\\settings.json",
        "C:\\custom\\.gemini\\agent-gateway.json",
      ],
    );
    assert.deepStrictEqual(
      geminiCliAdapter.detectPaths("C:\\Users\\u", "win32"),
      ["C:\\custom\\.gemini"],
    );
  });

  test("creates automatic API-key configuration and removes created files on undo", () => {
    const plan = geminiCliAdapter.plan(input, {});
    const files = apply({}, plan);
    assert.strictEqual(plan.manualSteps, undefined);
    assert.ok(files[ENV]!.includes(`GEMINI_API_KEY='${PLACEHOLDER_API_KEY}'`));
    assert.ok(
      files[ENV]!.includes(`GOOGLE_GEMINI_BASE_URL='${input.gatewayUrl}'`),
    );
    assert.ok(files[ENV]!.includes(`GEMINI_MODEL='${input.defaultModel}'`));
    assert.strictEqual(
      parse(files[SETTINGS]!).security.auth.selectedType,
      "gemini-api-key",
    );
    assert.deepStrictEqual(geminiCliAdapter.plan(input, files).changes, []);
    const restored = apply(files, geminiCliAdapter.unplan(input, files));
    assert.strictEqual(restored[ENV], undefined);
    assert.strictEqual(restored[SETTINGS], undefined);
    assert.strictEqual(restored[BACKUP], undefined);
    assert.deepStrictEqual(
      geminiCliAdapter.unplan(input, restored).changes,
      [],
    );
  });

  const original: Files = {
    [ENV]:
      "# My endpoint\r\nexport GOOGLE_GEMINI_BASE_URL=https://example.com # retain comment\r\nGEMINI_API_KEY='old-key'\r\nGEMINI_MODEL=old-model\r\nOTHER=value",
    [SETTINGS]: `{
  // retain auth comments
  "security": { "auth": { "selectedType": "oauth-personal", "enforcedType": "oauth-personal" } },
  "model": { "name": "old-model" },
  "ui": { "theme": "Default" }
}
`,
  };

  test("preserves comments, old key/model and unrelated settings with exact undo", () => {
    const files = apply(
      original,
      geminiCliAdapter.plan({ ...input, apiKey: "gateway-key" }, original),
    );
    assert.ok(files[ENV]!.startsWith(original[ENV]!));
    assert.ok(files[ENV]!.includes("GEMINI_API_KEY='gateway-key'"));
    assert.ok(files[ENV]!.includes("\r\n# agent-gateway:start\r\n"));
    assert.ok(files[SETTINGS]!.includes("// retain auth comments"));
    assert.strictEqual(parse(files[SETTINGS]!).model.name, "old-model");
    assert.strictEqual(
      parse(files[SETTINGS]!).security.auth.enforcedType,
      "oauth-personal",
    );
    const restored = apply(files, geminiCliAdapter.unplan(input, files));
    assert.strictEqual(restored[ENV], original[ENV]);
    assert.strictEqual(restored[SETTINGS], original[SETTINGS]);
  });

  test("updates key, model and endpoint without replacing original backup", () => {
    const once = apply(original, geminiCliAdapter.plan(input, original));
    const updatedInput = {
      ...input,
      apiKey: "next-key",
      defaultModel: "remote--gemini-3.8-flash",
      gatewayUrl: "http://127.0.0.1:25555",
    };
    const updated = apply(once, geminiCliAdapter.plan(updatedInput, once));
    assert.ok(updated[ENV]!.includes("GEMINI_API_KEY='next-key'"));
    assert.ok(
      updated[ENV]!.includes("GEMINI_MODEL='remote--gemini-3.8-flash'"),
    );
    assert.ok(
      updated[ENV]!.includes("GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:25555'"),
    );
    assert.strictEqual(
      (updated[ENV]!.match(/# agent-gateway:start/g) ?? []).length,
      1,
    );
    assert.deepStrictEqual(
      geminiCliAdapter.plan(updatedInput, updated).changes,
      [],
    );
    const restored = apply(
      updated,
      geminiCliAdapter.unplan(updatedInput, updated),
    );
    assert.strictEqual(restored[ENV], original[ENV]);
    assert.strictEqual(restored[SETTINGS], original[SETTINGS]);
  });

  test("undo preserves unrelated edits made after configure and reconfigure", () => {
    let files = apply(original, geminiCliAdapter.plan(input, original));
    files[ENV] += "# new setting\r\nNEW=value\r\n";
    files[SETTINGS] = files[SETTINGS]!.replace('"Default"', '"Dark"');
    files = apply(files, geminiCliAdapter.plan(input, files));
    const restored = apply(files, geminiCliAdapter.unplan(input, files));
    assert.ok(restored[ENV]!.includes("# My endpoint"));
    assert.ok(restored[ENV]!.includes("GEMINI_MODEL=old-model"));
    assert.ok(restored[ENV]!.includes("# new setting\r\nNEW=value"));
    assert.ok(!restored[ENV]!.includes("# agent-gateway:start"));
    assert.strictEqual(
      parse(restored[SETTINGS]!).security.auth.selectedType,
      "oauth-personal",
    );
    assert.strictEqual(parse(restored[SETTINGS]!).ui.theme, "Dark");
  });

  test("undo preserves a subsequently selected auth mode", () => {
    const files = apply(original, geminiCliAdapter.plan(input, original));
    files[SETTINGS] = files[SETTINGS]!.replace("gemini-api-key", "vertex-ai");
    const restored = apply(files, geminiCliAdapter.unplan(input, files));
    assert.strictEqual(
      parse(restored[SETTINGS]!).security.auth.selectedType,
      "vertex-ai",
    );
  });

  test("undo without ownership does not alter existing configuration", () => {
    assert.deepStrictEqual(
      geminiCliAdapter.unplan(input, original).changes,
      [],
    );
  });

  test("keeps an already matching user-owned auth mode and empty files", () => {
    for (const settings of [
      "",
      '{"security":{"auth":{"selectedType":"gemini-api-key"}}}',
    ]) {
      const initial = { [ENV]: "", [SETTINGS]: settings };
      const files = apply(initial, geminiCliAdapter.plan(input, initial));
      const restored = apply(files, geminiCliAdapter.unplan(input, files));
      assert.strictEqual(restored[ENV], "");
      assert.strictEqual(restored[SETTINGS], settings);
    }
  });

  test("quotes special dotenv values without interpolation", () => {
    const files = apply(
      {},
      geminiCliAdapter.plan({ ...input, apiKey: "key'with#$\\n" }, {}),
    );
    assert.ok(files[ENV]!.includes("GEMINI_API_KEY=`key'with#$\\n`"));
    assert.throws(
      () => geminiCliAdapter.plan({ ...input, apiKey: "bad\nkey" }, {}),
      /line breaks/,
    );
  });

  test("rejects malformed settings, backup and orphaned managed blocks", () => {
    assert.throws(
      () => geminiCliAdapter.plan(input, { [SETTINGS]: "{" }),
      /valid JSON/,
    );
    assert.throws(
      () => geminiCliAdapter.plan(input, { [BACKUP]: "{}" }),
      /backup is invalid/,
    );
    assert.throws(
      () => geminiCliAdapter.plan(input, { [ENV]: "# agent-gateway:start\n" }),
      /block is invalid/,
    );
    assert.throws(
      () =>
        geminiCliAdapter.plan(input, {
          [ENV]: "# agent-gateway:start\n# agent-gateway:end\n",
        }),
      /backup is missing/,
    );
  });
});
