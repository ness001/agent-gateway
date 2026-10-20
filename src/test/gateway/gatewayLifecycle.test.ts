import * as assert from "assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type * as vscode from "vscode";

import { Gateway } from "../../gateway/gateway";
import { DEFAULT_CONFIG, type GatewayConfiguration } from "../../utils/config";

const fakeContext = {
  secrets: { get: async () => undefined },
  extension: { packageJSON: { version: "0.0.0-test" } },
} as unknown as vscode.ExtensionContext;

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

suite("Gateway lifecycle", () => {
  test("port conflict retries and binds after the owner exits", async () => {
    const owner = http.createServer((req, res) => {
      res.writeHead(req.url === "/v1/models" ? 200 : 404, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [] } : {}));
    });
    await new Promise<void>((r) => owner.listen(0, "127.0.0.1", () => r()));
    const port = (owner.address() as AddressInfo).port;
    const config: GatewayConfiguration = { ...DEFAULT_CONFIG, port };
    const conflicts: string[] = [];
    const gw = new Gateway(fakeContext, {
      readConfig: () => config,
      portRetryMs: 100,
    });
    gw.onDidEnterPortConflict((c) => conflicts.push(c.occupant));
    try {
      await gw.start();
      assert.strictEqual(gw.state, "Port conflict");
      assert.match(gw.health().lastStartupError ?? "", /another local gateway/);
      // Owner is untouched across several retries; notified only once.
      await new Promise((r) => setTimeout(r, 350));
      assert.ok(owner.listening);
      assert.deepStrictEqual(conflicts, ["other-gateway"]);
      await new Promise<void>((r) => {
        owner.closeAllConnections();
        owner.close(() => r());
      });
      await waitFor(() => gw.port === port);
      assert.notStrictEqual(gw.state, "Port conflict");
      assert.strictEqual(gw.health().lastStartupError, null);
      assert.strictEqual(gw.portConflict, undefined);
    } finally {
      await gw.stop();
      gw.dispose();
      if (owner.listening) {
        owner.close();
      }
    }
  });

  test("enabled=false stops the listener and frees the port", async () => {
    const port = await freePort();
    const config: GatewayConfiguration = { ...DEFAULT_CONFIG, port };
    const gw = new Gateway(fakeContext, { readConfig: () => config });
    try {
      await gw.start();
      assert.strictEqual(gw.port, port);
      config.enabled = false;
      await gw.restart();
      assert.strictEqual(gw.state, "Disabled");
      assert.strictEqual(gw.port, undefined);
      // Without restart, start() alone must also release the port.
      config.enabled = true;
      await gw.start();
      assert.strictEqual(gw.port, port);
      config.enabled = false;
      await gw.start();
      assert.strictEqual(gw.port, undefined);
      const probe = http.createServer();
      await new Promise<void>((r, j) =>
        probe.once("error", j).listen(port, "127.0.0.1", () => r()),
      );
      await new Promise<void>((r) => probe.close(() => r()));
    } finally {
      await gw.stop();
      gw.dispose();
    }
  });
});
