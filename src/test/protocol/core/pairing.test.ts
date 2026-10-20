import * as assert from "assert";

import {
  MISSING_RESULT_TEXT,
  inferGeminiCallIds,
  logRepairs,
  repairPairing,
} from "../../../protocol/core/pairing";
import type {
  Part,
  ToolCallPart,
  ToolResultPart,
  Turn,
} from "../../../protocol/core/types";

const call = (id: string, name = "tool"): ToolCallPart => ({
  type: "toolCall",
  id,
  name,
  input: { secret: "ARGS" },
});
const result = (
  callId: string,
  text = "RESULT",
  name?: string,
): ToolResultPart => ({
  type: "toolResult",
  callId,
  name,
  content: [{ type: "text", text }],
  isError: false,
});
const user = (...parts: Part[]): Turn => ({ role: "user", parts });
const asst = (...parts: Part[]): Turn => ({ role: "assistant", parts });
const text = (t: string): Part => ({ type: "text", text: t });

suite("core/pairing", () => {
  test("well-formed history is unchanged", () => {
    const turns = [
      user(text("hi")),
      asst(call("a"), call("b")),
      user(result("a"), result("b"), text("more")),
    ];
    const out = repairPairing(turns);
    assert.deepStrictEqual(out.turns, turns);
    assert.deepStrictEqual(out.repairs, []);
  });

  test("missing result gets synthetic error result", () => {
    const out = repairPairing([user(text("hi")), asst(call("a", "read"))]);
    assert.deepStrictEqual(out.turns[2], {
      role: "user",
      parts: [
        {
          type: "toolResult",
          callId: "a",
          name: "read",
          content: [{ type: "text", text: MISSING_RESULT_TEXT }],
          isError: true,
        },
      ],
    });
    assert.deepStrictEqual(out.repairs, [
      {
        kind: "missing_result",
        toolName: "read",
        callId: "a",
        messageIndex: 1,
      },
    ]);
  });

  test("missing result followed by assistant turn inserts user turn", () => {
    const out = repairPairing([asst(call("a")), asst(text("x"))]);
    assert.strictEqual(out.turns.length, 3);
    assert.strictEqual(out.turns[1].role, "user");
    assert.strictEqual(out.turns[2].role, "assistant");
  });

  test("orphan result becomes text", () => {
    const orphan: ToolResultPart = {
      type: "toolResult",
      callId: "zz",
      content: [
        { type: "text", text: "body" },
        { type: "image", mime: "image/png", data: new Uint8Array([1]) },
      ],
      isError: false,
    };
    const out = repairPairing([user(orphan, text("q"))]);
    assert.deepStrictEqual(out.turns, [
      user(text("[tool result zz]\nbody\n[image image/png]"), text("q")),
    ]);
    assert.deepStrictEqual(out.repairs, [
      { kind: "orphan_result", toolName: "", callId: "zz", messageIndex: 0 },
    ]);
  });

  test("result before its call is an orphan", () => {
    const out = repairPairing([user(result("a", "r", "n")), asst(call("a"))]);
    assert.deepStrictEqual(
      out.repairs.map((r) => [r.kind, r.toolName]),
      [
        ["orphan_result", "n"],
        ["missing_result", "tool"],
      ],
    );
  });

  test("orphan in turn right after calls stays as text", () => {
    const out = repairPairing([
      asst(call("a")),
      user(result("a"), result("q")),
    ]);
    assert.deepStrictEqual(out.turns[1].parts[0], result("a"));
    assert.strictEqual(out.turns[1].parts[1].type, "text");
  });

  test("out-of-order results are reordered", () => {
    const out = repairPairing([
      asst(call("a"), call("b")),
      user(result("b"), result("a")),
    ]);
    assert.deepStrictEqual(out.turns[1].parts, [result("a"), result("b")]);
    assert.deepStrictEqual(
      out.repairs.map((r) => r.kind),
      ["reordered", "reordered"],
    );
  });

  test("late result is moved to follow its call", () => {
    const out = repairPairing([
      asst(call("a")),
      user(text("interjection")),
      asst(text("ok")),
      user(result("a")),
    ]);
    assert.deepStrictEqual(out.turns, [
      asst(call("a")),
      user(result("a"), text("interjection")),
      asst(text("ok")),
    ]);
    assert.deepStrictEqual(out.repairs, [
      { kind: "reordered", toolName: "tool", callId: "a", messageIndex: 3 },
    ]);
  });

  test("duplicate results are removed", () => {
    const out = repairPairing([
      asst(call("a")),
      user(result("a", "1"), result("a", "2")),
    ]);
    assert.deepStrictEqual(out.turns[1].parts, [result("a", "1")]);
    assert.deepStrictEqual(out.repairs, [
      { kind: "duplicate", toolName: "tool", callId: "a", messageIndex: 1 },
    ]);
  });

  test("input is not mutated", () => {
    const turns = [asst(call("a")), user(result("x"))];
    const copy = JSON.parse(JSON.stringify(turns));
    repairPairing(turns);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(turns)), copy);
  });

  test("logRepairs writes one line per repair without content", () => {
    const lines: string[] = [];
    const { repairs } = repairPairing([
      asst(call("a", "read")),
      user(result("zz", "SECRETRESULT")),
    ]);
    logRepairs(repairs, { warn: (m) => lines.push(m) }, "req-1", "anthropic");
    assert.strictEqual(lines.length, repairs.length);
    assert.strictEqual(lines.length, 2);
    for (const l of lines) {
      assert.ok(l.includes("req-1") && l.includes("anthropic"));
      assert.ok(!l.includes("SECRETRESULT") && !l.includes("ARGS"));
    }
    assert.ok(
      lines.some((l) =>
        /missing_result.*read.*callId=a.*messageIndex=0/.test(l),
      ),
    );
    logRepairs(
      repairs.slice(0, 1),
      { warn: (m) => lines.push(m) },
      undefined,
      "p",
    );
    assert.ok(lines[2].startsWith("[-]"));
  });

  test("repaired history alternates call then result turn", () => {
    const out = repairPairing([
      user(text("go")),
      asst(call("a"), call("b")),
      user(result("b")),
    ]);
    const t = out.turns[2];
    assert.strictEqual(t.role, "user");
    assert.deepStrictEqual(
      t.parts.map((p) => (p as ToolResultPart).callId),
      ["a", "b"],
    );
    assert.strictEqual((t.parts[0] as ToolResultPart).isError, true);
  });

  test("functionResponse matched to functionCall by name and order", () => {
    const turns = inferGeminiCallIds([
      asst(call("", "f"), call("", "g"), call("", "f")),
      user(result("", "g1", "g"), result("", "f1", "f"), result("", "f2", "f")),
    ]);
    const ids = (turns[0].parts as ToolCallPart[]).map((c) => c.id);
    assert.strictEqual(new Set(ids).size, 3);
    assert.deepStrictEqual(
      (turns[1].parts as ToolResultPart[]).map((r) => r.callId),
      [ids[1], ids[0], ids[2]],
    );
    assert.deepStrictEqual(
      repairPairing(turns).repairs.map((r) => r.kind),
      ["reordered", "reordered"],
    );
  });

  test("explicit ids are kept and unmatched names stay id-less", () => {
    const turns = inferGeminiCallIds([
      user(text("hi")),
      asst(text("thinking"), call("x1", "f")),
      user(result("x1", "r", "f"), result("", "r", "nope"), text("t")),
      asst(text("no calls")),
      user(result("", "r", "f")),
    ]);
    assert.strictEqual((turns[1].parts[1] as ToolCallPart).id, "x1");
    assert.strictEqual((turns[2].parts[0] as ToolResultPart).callId, "x1");
    assert.strictEqual((turns[2].parts[1] as ToolResultPart).callId, "");
    assert.strictEqual((turns[4].parts[0] as ToolResultPart).callId, "");
  });
});
