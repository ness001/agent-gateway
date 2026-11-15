import * as assert from "node:assert/strict";

import { STATUS_COMMANDS } from "../../commands/status";
import type { HealthSnapshot } from "../../gateway/health";
import { GatewayStatusProvider } from "../../views/status";

suite("Gateway status sidebar", () => {
  test("refresh reads current health and counts native models without aliases", () => {
    const health = {
      status: "Starting",
      bridgeVersion: "0.1.8",
      listener: { active: false, address: null },
      copilot: { installed: true, active: false },
      remotes: [],
      fallbackModel: null,
      lastStartupError: null,
    } as unknown as HealthSnapshot;
    let models = 0;
    const provider = new GatewayStatusProvider(
      () => health,
      () => models,
    );
    let refreshes = 0;
    const subscription = provider.onDidChangeTreeData(() => refreshes++);
    try {
      assert.equal(
        provider.getChildren().find((i) => i.id === "state")?.description,
        "Starting",
      );
      assert.equal(
        provider.getChildren().find((i) => i.id === "listener")?.description,
        "Inactive",
      );
      health.status = "Ready";
      health.listener = { active: true, address: "http://127.0.0.1:24444" };
      models = 3;
      provider.refresh();
      assert.equal(refreshes, 1);
      const rows = provider.getChildren();
      assert.equal(rows.find((i) => i.id === "state")?.description, "Ready");
      assert.equal(
        rows.find((i) => i.id === "listener")?.description,
        health.listener.address,
      );
      assert.equal(rows.find((i) => i.id === "models")?.description, "3");
      assert.deepEqual(
        rows.slice(-2).map((i) => i.id),
        ["copilot", "version"],
      );
      assert.deepEqual(
        new Set(rows.flatMap((i) => (i.command ? [i.command.command] : []))),
        new Set(Object.values(STATUS_COMMANDS)),
      );
      assert.equal(
        rows.find((i) => i.id === "listener")?.command?.command,
        STATUS_COMMANDS.changePort,
      );
      assert.equal(
        rows.find((i) => i.id === "models")?.command?.command,
        STATUS_COMMANDS.models,
      );
      assert.equal(
        rows.find((i) => i.id === "remotes")?.command?.command,
        STATUS_COMMANDS.remotes,
      );
      assert.equal(
        rows.find((i) => i.id === "fallback")?.command?.command,
        STATUS_COMMANDS.fallbackModel,
      );
      assert.equal(
        rows.find((i) => i.id === "restart")?.command?.command,
        "agentGateway.restart",
      );
    } finally {
      subscription.dispose();
      provider.dispose();
    }
  });
});
