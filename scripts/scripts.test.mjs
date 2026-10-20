// Node-only unit tests for the build scripts; run with `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { packageOf, summarize } from "./bundle-budget.mjs";

test("packageOf handles scoped, nested and app inputs", () => {
  assert.equal(
    packageOf("node_modules/.pnpm/a@1/node_modules/@scope/pkg/x.js"),
    "@scope/pkg",
  );
  assert.equal(packageOf("node_modules\\zod\\lib\\index.js"), "zod");
  assert.equal(packageOf("src/extension.ts"), "(app)");
});

test("summarize sorts inputs and sums per package", () => {
  const meta = {
    outputs: {
      "dist/extension.cjs": {
        inputs: {
          "src/a.ts": { bytesInOutput: 5 },
          "node_modules/z/a.js": { bytesInOutput: 7 },
          "node_modules/z/b.js": { bytesInOutput: 4 },
        },
      },
    },
  };
  const s = summarize(meta);
  assert.equal(s.inputs[0].path, "node_modules/z/a.js");
  assert.deepEqual(s.packages, [
    { name: "z", bytes: 11 },
    { name: "(app)", bytes: 5 },
  ]);
});
