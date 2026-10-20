import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ErrorJournal,
  type ErrorRecord,
  RECENT_ERROR_LIMIT,
  pruneErrorLogs,
} from "../../gateway/errorJournal";

const rec = (i: number, time = "2026-10-18T10:00:00.000Z"): ErrorRecord => ({
  time,
  requestId: `r${i}`,
  protocol: "anthropic",
  method: "POST",
  path: "/v1/messages",
  status: 400,
  kind: "invalid_request",
  elapsedMs: 5,
});

suite("ErrorJournal", () => {
  test("keeps the most recent failures, newest first", () => {
    const j = new ErrorJournal(undefined);
    for (let i = 0; i < RECENT_ERROR_LIMIT + 5; i++) {
      j.record(rec(i));
    }
    const recent = j.recentErrors();
    assert.strictEqual(recent.length, RECENT_ERROR_LIMIT);
    assert.strictEqual(recent[0].requestId, `r${RECENT_ERROR_LIMIT + 4}`);
    assert.deepStrictEqual(j.countsByKind(), {
      "400 invalid_request": RECENT_ERROR_LIMIT + 5,
    });
  });

  test("appends JSON lines to a daily file and prunes old days", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-errors-"));
    try {
      await fs.writeFile(path.join(dir, "errors-2026-10-01.jsonl"), "{}\n");
      await fs.writeFile(path.join(dir, "keep.txt"), "x");
      const j = new ErrorJournal(dir, 7);
      j.record(rec(1));
      j.record(rec(2));
      await j.flush();
      const lines = (
        await fs.readFile(path.join(dir, "errors-2026-10-18.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      assert.deepStrictEqual(
        lines.map((l) => JSON.parse(l).requestId),
        ["r1", "r2"],
      );
      const names = (await fs.readdir(dir)).sort();
      assert.deepStrictEqual(names, ["errors-2026-10-18.jsonl", "keep.txt"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("prune keeps files inside the retention window", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-errors-"));
    try {
      for (const d of ["2026-10-10", "2026-10-11", "2026-10-17"]) {
        await fs.writeFile(path.join(dir, `errors-${d}.jsonl`), "");
      }
      const removed = await pruneErrorLogs(
        dir,
        7,
        new Date("2026-10-18T12:00:00Z"),
      );
      assert.deepStrictEqual(removed, ["errors-2026-10-10.jsonl"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a write failure never throws to the caller", async () => {
    const file = path.join(os.tmpdir(), `act-not-a-dir-${process.pid}`);
    await fs.writeFile(file, "x");
    try {
      const j = new ErrorJournal(path.join(file, "sub"));
      j.record(rec(1));
      await j.flush();
      assert.strictEqual(j.recentErrors().length, 1);
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
