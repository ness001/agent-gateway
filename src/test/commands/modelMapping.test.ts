import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

suite("commands AI mapping interaction", () => {
  test("isolated VS Code interaction scenarios", function () {
    this.timeout(15000);
    const root = path.resolve(__dirname, "../../..");
    // Run in a separate process so the VS Code mock cannot affect other suites.
    const output = execFileSync(
      process.execPath,
      ["--test", "scripts/model-mapping.test.cjs"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    assert.ok(output.includes("tests"), "the interaction suite must execute");
  });
});
