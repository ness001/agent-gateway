import * as assert from "assert";

import { cursorAdapter } from "../../clients/cursor";
import { ClientConfigInput, PLACEHOLDER_API_KEY } from "../../clients/types";

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444",
    models: [
      {
        id: "claude-sonnet-4",
        displayName: "S",
        contextWindow: 200000,
        inputModalities: ["text"],
        supportsToolCalling: true,
        reasoning: false,
      },
      {
        id: "gpt-4.1",
        displayName: "G",
        contextWindow: null,
        inputModalities: ["text"],
        supportsToolCalling: true,
        reasoning: false,
      },
    ],
    defaultModel: "claude-sonnet-4",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

suite("cursor adapter", () => {
  test("cursor warns on loopback", () => {
    const p = cursorAdapter.plan(input(), {});
    assert.deepStrictEqual(p.changes, []);
    assert.ok(p.manualSteps![0].startsWith("WARNING"));
    assert.ok(p.summary[0].includes("loopback"));
    assert.ok(
      p.manualSteps!.some((s) => s.includes("claude-sonnet-4, gpt-4.1")),
    );
    assert.ok(p.clipboard!.includes("gpt-4.1"));
  });

  test("cursor with public URL does not leak key", () => {
    const p = cursorAdapter.plan(
      input({ gatewayUrl: "https://abc.devtunnels.ms", apiKey: "secret" }),
      {},
    );
    assert.ok(!p.manualSteps![0].startsWith("WARNING"));
    assert.ok(
      p.clipboard!.startsWith("Base URL: https://abc.devtunnels.ms/v1"),
    );
    assert.ok(!JSON.stringify(p).includes("secret"));
    assert.deepStrictEqual(cursorAdapter.unplan(input(), {}).changes, []);
  });
});
