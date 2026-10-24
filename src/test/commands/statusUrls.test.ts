import * as assert from "node:assert";
import * as vscode from "vscode";

import { showStatus, statusItems } from "../../commands/status";
import type { Gateway } from "../../gateway/gateway";
import type { HealthSnapshot } from "../../gateway/health";

function health(
  listener: HealthSnapshot["listener"] = {
    active: true,
    address: "http://127.0.0.1:4141",
  },
): HealthSnapshot {
  return {
    status: "Ready",
    bridgeVersion: "1",
    buildTime: "unbundled",
    listener,
    vscodeVersion: "1",
    copilot: { installed: true, active: true },
    modelCount: 0,
    lastDiscoveryTime: null,
    lastStartupError: null,
    remotes: [],
    fallbackModel: null,
    fallbackModelSource: null,
    errors: { counts: {}, recent: [] },
  };
}

suite("commands/status API URLs", () => {
  test("lists only supported routes using the actual listener address", () => {
    const items = statusItems(health()).filter((i) => i.url);
    assert.deepStrictEqual(
      items.map((i) => i.url),
      [
        "http://127.0.0.1:4141",
        "http://127.0.0.1:4141/v1",
        "http://127.0.0.1:4141/v1/models",
        "http://127.0.0.1:4141/v1/chat/completions",
        "http://127.0.0.1:4141/v1/responses",
        "http://127.0.0.1:4141/v1/messages",
        "http://127.0.0.1:4141/v1/messages/count_tokens",
        "http://127.0.0.1:4141/v1beta/models/{model}:generateContent",
        "http://127.0.0.1:4141/v1beta/models/{model}:streamGenerateContent?alt=sse",
        "http://127.0.0.1:4141/v1beta/models/{model}:countTokens",
      ],
    );
    assert.ok(items.every((i) => i.description === i.url && !i.action));
    assert.ok(
      items
        .filter((i) => i.url?.includes("{model}"))
        .every((i) => i.detail?.includes("Replace {model}")),
    );
  });

  test("does not invent URLs when the listener is inactive or missing", () => {
    for (const listener of [
      { active: false, address: null },
      { active: false, address: "http://127.0.0.1:4141" },
      { active: true, address: null },
    ]) {
      assert.ok(!statusItems(health(listener)).some((i) => i.url));
    }
  });

  test("normalizes a trailing slash without changing the listener host", () => {
    const items = statusItems(
      health({ active: true, address: "http://[::1]:5151/" }),
    );
    assert.strictEqual(
      items.find((i) => i.label === "$(copy) Models")?.url,
      "http://[::1]:5151/v1/models",
    );
  });

  test("selecting a URL copies it exactly without dispatching an action", async () => {
    const showQuickPick = vscode.window.showQuickPick;
    const showInformationMessage = vscode.window.showInformationMessage;
    const clipboard = await vscode.env.clipboard.readText();
    const selected = statusItems(health()).find((i) =>
      i.url?.endsWith("/v1/messages/count_tokens"),
    );
    Object.assign(vscode.window, {
      showQuickPick: async () => selected,
      showInformationMessage: async () => undefined,
    });
    try {
      await showStatus(
        { health } as Gateway,
        {} as Parameters<typeof showStatus>[1],
      );
      assert.strictEqual(
        await vscode.env.clipboard.readText(),
        "http://127.0.0.1:4141/v1/messages/count_tokens",
      );
    } finally {
      Object.assign(vscode.window, {
        showQuickPick,
        showInformationMessage,
      });
      await vscode.env.clipboard.writeText(clipboard);
    }
  });
});
