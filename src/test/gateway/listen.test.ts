import * as assert from "assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  PortConflictError,
  portConflictMessage,
  probeOccupant,
  start,
} from "../../gateway/listen";

async function startServer(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const app = { fetch: () => new Response("ok") };

suite("listen: port conflict", () => {
  test("detects another extension gateway via /health", async () => {
    const s = await startServer((_req, res) =>
      json(res, 200, { status: "Ready", bridgeVersion: "0.1.0" }),
    );
    try {
      assert.strictEqual(await probeOccupant(s.port), "extension");
    } finally {
      await s.close();
    }
  });

  test("treats 401 on /health as an extension gateway", async () => {
    const s = await startServer((_req, res) => json(res, 401, {}));
    try {
      assert.strictEqual(await probeOccupant(s.port), "extension");
    } finally {
      await s.close();
    }
  });

  test("detects another local gateway", async () => {
    const s = await startServer((req, res) =>
      req.url === "/v1/models"
        ? json(res, 200, { object: "list", data: [] })
        : json(res, 404, { error: { message: "not found" } }),
    );
    try {
      assert.strictEqual(await probeOccupant(s.port), "other-gateway");
      const err = await start(app, s.port).then(
        () => assert.fail("expected conflict"),
        (e: unknown) => e,
      );
      assert.ok(err instanceof PortConflictError);
      assert.strictEqual(err.occupant, "other-gateway");
      assert.match(err.message, /another local gateway/);
    } finally {
      await s.close();
    }
  });

  test("unknown occupant and unresponsive port", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    try {
      assert.strictEqual(await probeOccupant(s.port), "unknown");
    } finally {
      await s.close();
    }
    assert.strictEqual(await probeOccupant(s.port, 300), "unknown");
    assert.strictEqual(
      portConflictMessage(1, "unknown"),
      "Port 1 is used by another process.",
    );
  });

  test("conflict does not disturb the owner and binding succeeds once freed", async () => {
    const s = await startServer((_req, res) => json(res, 200, { ok: true }));
    const port = s.port;
    await assert.rejects(start(app, port), PortConflictError);
    // Owner still serves.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(res.status, 200);
    await s.close();
    const listener = await start(app, port);
    try {
      assert.strictEqual(listener.port, port);
    } finally {
      await listener.close();
    }
  });
});
