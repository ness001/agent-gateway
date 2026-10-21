import * as assert from "assert";

import { recoverRejectedToolHistory } from "../../../protocol/core/toolRecovery";
import type { Turn } from "../../../protocol/core/types";

suite("protocol/core toolRecovery", () => {
  test("preserves images, error status and unrelated structured calls without mutation", () => {
    const image = {
      type: "image" as const,
      mime: "image/png",
      data: new Uint8Array([1, 2, 3]),
    };
    const turns: Turn[] = [
      {
        role: "assistant",
        parts: [
          {
            type: "toolCall",
            id: "call_one",
            name: "read",
            input: { path: "example" },
          },
          { type: "toolCall", id: "call_two", name: "other", input: {} },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "toolResult",
            callId: "call_one",
            content: [image, { type: "text", text: "result" }],
            isError: true,
          },
          {
            type: "toolResult",
            callId: "call_two",
            content: [],
            isError: false,
          },
        ],
      },
    ];
    const before = JSON.stringify(turns);
    const out = recoverRejectedToolHistory(
      turns,
      new Error(
        '400 {"error":{"message":"No tool call found for function call output with call_id call_one."}}',
      ),
    )!;
    assert.ok(out);
    assert.ok(out[1].parts.includes(image));
    assert.ok(JSON.stringify(out).includes("(error)"));
    assert.strictEqual(out[0].parts[1], turns[0].parts[1]);
    assert.strictEqual(out[1].parts.at(-1), turns[1].parts[1]);
    assert.strictEqual(JSON.stringify(turns), before);
  });

  test("requires both call and result and rejects loosely matching errors", () => {
    const turns: Turn[] = [
      {
        role: "assistant",
        parts: [{ type: "toolCall", id: "call_one", name: "read", input: {} }],
      },
    ];
    for (const err of [
      new Error(
        "No tool call found for function call output with call_id call_one.",
      ),
      new Error("missing call_one"),
      "call_one",
    ]) {
      assert.strictEqual(recoverRejectedToolHistory(turns, err), undefined);
    }
  });
});
