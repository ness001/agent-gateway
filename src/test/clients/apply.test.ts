import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyPlan,
  backupStamp,
  loadFiles,
  redactSecrets,
} from "../../clients/apply";
import { ALL_CLIENT_ADAPTERS } from "../../clients/index";

suite("clients/apply", () => {
  let dir: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-apply-"));
  });
  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("loadFiles returns undefined for missing files", async () => {
    const a = path.join(dir, "a.txt");
    await fs.writeFile(a, "A");
    const files = await loadFiles([a, path.join(dir, "missing")]);
    assert.deepStrictEqual(Object.values(files), ["A", undefined]);
  });

  test("backs up existing files and creates new ones with parent dirs", async () => {
    const existing = path.join(dir, "cfg.toml");
    const created = path.join(dir, "sub", "deep", "new.json");
    await fs.writeFile(existing, "old");
    const now = new Date(2026, 9, 17, 8, 5, 9);
    const backups = await applyPlan(
      {
        changes: [
          { path: existing, before: "old", after: "new" },
          { path: created, before: undefined, after: "{}" },
          { path: path.join(dir, "same"), before: "x", after: "x" },
        ],
      },
      { now },
    );
    assert.strictEqual(backupStamp(now), "20261017080509");
    assert.deepStrictEqual(backups, [
      `${existing}.agent-gateway-20261017080509.bak`,
    ]);
    assert.strictEqual(await fs.readFile(backups[0], "utf8"), "old");
    assert.strictEqual(await fs.readFile(existing, "utf8"), "new");
    assert.strictEqual(await fs.readFile(created, "utf8"), "{}");
    assert.deepStrictEqual((await fs.readdir(dir)).sort(), [
      "cfg.toml",
      "cfg.toml.agent-gateway-20261017080509.bak",
      "sub",
    ]);
  });

  test("undefined after deletes the file after backing it up", async () => {
    const f = path.join(dir, "gone.yml");
    await fs.writeFile(f, "a: 1");
    const backups = await applyPlan({
      changes: [{ path: f, before: "a: 1", after: undefined }],
    });
    assert.strictEqual(backups.length, 1);
    assert.strictEqual((await loadFiles([f]))[f], undefined);
  });

  test("refuses to overwrite a file changed since the preview", async () => {
    const f = path.join(dir, "cfg.json");
    await fs.writeFile(f, "edited by user");
    await assert.rejects(
      applyPlan({ changes: [{ path: f, before: "old", after: "new" }] }),
      /changed since the preview/,
    );
    assert.strictEqual(await fs.readFile(f, "utf8"), "edited by user");
    assert.deepStrictEqual(await fs.readdir(dir), ["cfg.json"]);
  });

  test("redactSecrets hides the api key", () => {
    assert.strictEqual(
      redactSecrets('k = "sk-secret-1"; again sk-secret-1', ["sk-secret-1"]),
      'k = "<redacted>"; again <redacted>',
    );
    assert.strictEqual(redactSecrets("abc", [undefined, ""]), "abc");
  });

  test("adapters are registered in order", () => {
    assert.deepStrictEqual(
      ALL_CLIENT_ADAPTERS.map((a) => a.id),
      [
        "codex",
        "claude-code",
        "omp",
        "pi",
        "openclaw",
        "hermes",
        "kilo",
        "cline",
        "deepseek-harness",
        "antigravity",
        "cursor",
      ],
    );
  });
});
