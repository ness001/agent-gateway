import * as assert from "assert";

import {
  DevTunnelCli,
  DevTunnelError,
  type ExecFn,
  type ExecResult,
  TUNNEL_ID_PATTERN,
  clientSetupText,
  deriveTunnelUrl,
  findDevTunnelCli,
  sanitizeCliMessage,
} from "../../gateway/devTunnel";

type Handler = (args: string[]) => ExecResult;

function fakeExec(handler: Handler, calls: string[][] = []): ExecFn {
  return async (_file, args) => {
    calls.push(args);
    return handler(args);
  };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

function tunnelJson(
  id: string,
  ports: { portNumber: number; portUri?: string }[],
  anonymous = false,
): string {
  return JSON.stringify({
    tunnel: {
      tunnelId: id,
      ports,
      accessControl: anonymous
        ? [{ type: "Anonymous", subjects: [], scopes: ["connect"] }]
        : [],
    },
  });
}

suite("devTunnel", () => {
  test("CLI missing: not on PATH and no WinGet link", async () => {
    const exec = fakeExec(() => ({
      code: -1,
      stdout: "",
      stderr: "",
      spawnError: "ENOENT",
    }));
    assert.strictEqual(
      await findDevTunnelCli({
        exec,
        platform: "win32",
        localAppData: "C:\\x",
        exists: () => false,
      }),
      undefined,
    );
  });

  test("CLI falls back to WinGet links on Windows", async () => {
    const exec = fakeExec(() => ({
      code: -1,
      stdout: "",
      stderr: "",
      spawnError: "ENOENT",
    }));
    const found = await findDevTunnelCli({
      exec,
      platform: "win32",
      localAppData: "C:\\x",
      exists: () => true,
    });
    assert.ok(found?.endsWith("devtunnel.exe"));
  });

  test("CLI on PATH is preferred", async () => {
    assert.strictEqual(
      await findDevTunnelCli({ exec: fakeExec(() => ok("1.0")) }),
      "devtunnel",
    );
  });

  test("not logged in", async () => {
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec(() => ok("Not logged in.")),
    );
    assert.strictEqual(await cli.isLoggedIn(), false);
    const cli2 = new DevTunnelCli(
      "devtunnel",
      fakeExec(() => ({ code: 1, stdout: "", stderr: "x" })),
    );
    assert.strictEqual(await cli2.isLoggedIn(), false);
    const cli3 = new DevTunnelCli(
      "devtunnel",
      fakeExec(() => ok("Logged in as a@b.com using Microsoft.")),
    );
    assert.strictEqual(await cli3.isLoggedIn(), true);
  });

  test("reuses an existing tunnel without creating anything", async () => {
    const calls: string[][] = [];
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec(
        () =>
          ok(
            tunnelJson(
              "neat-fog.jpe1",
              [
                {
                  portNumber: 24445,
                  portUri: "https://99vsjvtz-24445.jpe1.devtunnels.ms/",
                },
              ],
              true,
            ),
          ),
        calls,
      ),
    );
    const r = await cli.ensureTunnel("neat-fog.jpe1", 24445);
    assert.deepStrictEqual(calls, [["show", "neat-fog.jpe1", "--json"]]);
    assert.strictEqual(r.url, "https://99vsjvtz-24445.jpe1.devtunnels.ms");
    assert.strictEqual(r.urlSource, "portUri");
    assert.strictEqual(r.created, false);
  });

  test("existing tunnel with a different port gets the port added", async () => {
    const calls: string[][] = [];
    let shows = 0;
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec((args) => {
        if (args[0] === "show") {
          shows++;
          return ok(
            tunnelJson(
              "t.jpe1",
              shows === 1
                ? [{ portNumber: 8080 }]
                : [
                    { portNumber: 8080 },
                    {
                      portNumber: 24445,
                      portUri: "https://t-24445.jpe1.devtunnels.ms/",
                    },
                  ],
              true,
            ),
          );
        }
        return ok("");
      }, calls),
    );
    const r = await cli.ensureTunnel("t.jpe1", 24445);
    assert.deepStrictEqual(
      calls.map((c) => c.slice(0, 2).join(" ")),
      ["show t.jpe1", "port create", "show t.jpe1"],
    );
    assert.strictEqual(r.portAdded, true);
    assert.strictEqual(r.url, "https://t-24445.jpe1.devtunnels.ms");
  });

  test("creates tunnel, port and anonymous access when stored ID is gone", async () => {
    const calls: string[][] = [];
    let created = false;
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec((args) => {
        if (args[0] === "show" && args[1] === "old.jpe1") {
          return { code: 2, stdout: "", stderr: "Tunnel not found in jpe1" };
        }
        if (args[0] === "create") {
          created = true;
          return ok(tunnelJson("new-one.jpe1", []));
        }
        if (args[0] === "show") {
          return ok(tunnelJson("new-one.jpe1", [{ portNumber: 24445 }]));
        }
        return ok("");
      }, calls),
    );
    const r = await cli.ensureTunnel("old.jpe1", 24445);
    assert.ok(created);
    assert.deepStrictEqual(calls[1], [
      "create",
      "--expiration",
      "30d",
      "--json",
    ]);
    assert.deepStrictEqual(calls[2], [
      "port",
      "create",
      "new-one.jpe1",
      "-p",
      "24445",
      "--protocol",
      "http",
    ]);
    assert.deepStrictEqual(calls[3], [
      "access",
      "create",
      "new-one.jpe1",
      "-p",
      "24445",
      "--anonymous",
    ]);
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.urlSource, "derived");
    assert.strictEqual(r.url, "https://new-one-24445.jpe1.devtunnels.ms");
  });

  test("create failure reports exit code, hint and redacted CLI message", async () => {
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec(() => ({
        code: 1,
        stdout: "",
        stderr:
          "Anonymous does not have 'create' access scope. token=eyJhbGciOi.eyJzdWIiOiIx.abc\n",
      })),
    );
    await assert.rejects(cli.create(), (e: unknown) => {
      assert.ok(e instanceof DevTunnelError);
      assert.strictEqual(e.exitCode, 1);
      assert.match(e.message, /exit code 1/);
      assert.match(e.message, /devtunnel user login/);
      assert.match(e.message, /create' access scope/);
      assert.ok(!e.message.includes("eyJhbGciOi"));
      return true;
    });
  });

  test("timeouts produce a fixed hint", async () => {
    const cli = new DevTunnelCli(
      "devtunnel",
      fakeExec(() => ({ code: -1, stdout: "", stderr: "", timedOut: true })),
      undefined,
      5000,
    );
    await assert.rejects(cli.show("x.jpe1"), /Timed out after 5s/);
  });

  test("URL derivation and sanitizing", () => {
    assert.strictEqual(
      deriveTunnelUrl("kind-horse.jpe1", 24445),
      "https://kind-horse-24445.jpe1.devtunnels.ms",
    );
    assert.strictEqual(
      deriveTunnelUrl("abc", 80),
      "https://abc-80.devtunnels.ms",
    );
    assert.strictEqual(sanitizeCliMessage("\n\n"), undefined);
    assert.strictEqual(
      sanitizeCliMessage("key " + "A".repeat(40)),
      "key [redacted]",
    );
  });

  test("client setup text has name and URL but no key", () => {
    const text = clientSetupText("My PC#1", "https://x-1.jpe1.devtunnels.ms");
    assert.match(text, /Name: My-PC-1/);
    assert.match(text, /URL: https:\/\/x-1\.jpe1\.devtunnels\.ms/);
    assert.match(text, /Manage Remote Upstreams/);
  });
});

suite("devTunnel id validation", () => {
  test("TUNNEL_ID_PATTERN rejects shell metacharacters", () => {
    assert.ok(TUNNEL_ID_PATTERN.test("brave-cat-abc123.usw2"));
    for (const bad of ["x; rm -rf ~", "a&b", "$(x)", "a b", "`x`", "-flag"]) {
      assert.ok(!TUNNEL_ID_PATTERN.test(bad), bad);
    }
  });
});
