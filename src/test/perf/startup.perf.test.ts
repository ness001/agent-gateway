import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { budgetFor, record } from "./results";

const REPO = path.resolve(__dirname, "..", "..", "..");
const BUNDLE = path.join(REPO, "dist", "extension.cjs");
const PROBE = path.join(REPO, "src", "test", "perf", "fixtures", "startup.cjs");
const RUNS = 5;

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

suite("Performance: startup", () => {
  test("bundle require and activate() until /health answers", async function () {
    if (!existsSync(BUNDLE)) {
      // Not built here on purpose: the test must not change dist/.
      console.log(
        "    skipped: dist/extension.cjs is missing; run `pnpm run build` first",
      );
      this.skip();
    }
    const requireMs: number[] = [];
    const activateMs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      // Fresh process per run, so every require is cold.
      // The test host is Electron; run its bundled Node.
      const out = execFileSync(
        process.execPath,
        [PROBE, BUNDLE, String(await freePort())],
        {
          encoding: "utf8",
          timeout: 20000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      const r = JSON.parse(out) as {
        requireMs: number;
        activateToHealthMs: number;
      };
      requireMs.push(r.requireMs);
      activateMs.push(r.activateToHealthMs);
    }
    const rows = [
      {
        metric: "require dist/extension.cjs",
        values: requireMs,
        budgetKey: "requireP95Ms",
      },
      {
        metric: "activate() to /health 200",
        values: activateMs,
        budgetKey: "activateToHealthP95Ms",
      },
    ];
    for (const row of rows) {
      const p95 = record({ group: "startup", ...row });
      const budget = budgetFor({ group: "startup", budgetKey: row.budgetKey });
      assert.ok(
        p95 <= budget,
        `${row.metric} p95 ${p95.toFixed(1)} ms > ${budget} ms`,
      );
    }
  });
});
