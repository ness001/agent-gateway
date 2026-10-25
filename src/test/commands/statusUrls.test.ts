import * as assert from "node:assert";
import * as vscode from "vscode";

import {
  DevTunnelConnection,
  type DevTunnelSharingState,
  devTunnelSharingState,
  shareActionItems,
  shareViaDevTunnel,
} from "../../commands/share";
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

suite("commands/status sharing", () => {
  test("shows connection progress, verified model count and check failure", () => {
    const states: [DevTunnelSharingState, string][] = [
      [{ status: "inactive" }, "Inactive"],
      [{ status: "starting" }, "Starting…"],
      [{ status: "connecting", url: "https://example.test" }, "Connecting…"],
      [{ status: "connected", modelCount: 2 }, "Connected (2 models)"],
      [
        { status: "checkFailed", reason: "HTTP 403" },
        "Connection check failed",
      ],
      [
        { status: "stopFailed", url: "https://example.test" },
        "Stop failed (still sharing)",
      ],
    ];
    for (const [state, label] of states) {
      const items = statusItems(health(), "info", state);
      const line = items.find((i) => i.label.startsWith("Dev tunnel sharing:"));
      assert.strictEqual(line?.label, `Dev tunnel sharing: ${label}`);
      assert.strictEqual(line?.description, state.url);
      assert.strictEqual(
        items.find((i) => i.action === "share")?.label,
        state.status === "inactive"
          ? "$(radio-tower) Start sharing via dev tunnel"
          : "$(radio-tower) Manage sharing via dev tunnel",
      );
      if (state.status === "connected") {
        assert.strictEqual(line?.detail, "Last connection check succeeded.");
      } else if (state.status === "checkFailed") {
        assert.strictEqual(line?.detail, "HTTP 403");
      }
      assert.ok(!line?.detail?.includes("readiness is not verified"));
    }
  });

  test("public catalog check authenticates, validates and counts models", async () => {
    const connection = new DevTunnelConnection();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const checking = connection.check("https://example.test", "test-key", {
      fetchImpl: async (url, init) => {
        assert.strictEqual(url, "https://example.test/v1/gateway/catalog");
        assert.strictEqual(
          (init?.headers as Record<string, string>).authorization,
          "Bearer test-key",
        );
        return pending;
      },
    });
    assert.strictEqual(connection.state.status, "connecting");
    const model = {
      id: "test-model",
      displayName: "Test model",
      contextWindow: 1024,
      inputModalities: ["text"],
      supportsToolCalling: true,
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "medium", description: "Medium" }],
      operations: ["openai.chatCompletions"],
    };
    release(
      Response.json({
        version: 1,
        models: [model, { ...model, id: "other-model" }],
      }),
    );
    assert.strictEqual(await checking, true);
    assert.deepStrictEqual(connection.state, {
      status: "connected",
      url: "https://example.test",
      modelCount: 2,
    });
  });

  test("failed checks use safe discovery reasons and reject invalid catalogs", async () => {
    for (const response of [
      new Response("private response body", { status: 403 }),
      Response.json({ version: 1, models: [{ id: "invalid" }] }),
    ]) {
      const connection = new DevTunnelConnection();
      await connection.check("https://example.test", undefined, {
        fetchImpl: async () => response,
      });
      assert.strictEqual(connection.state.status, "checkFailed");
      assert.match(
        connection.state.reason ?? "",
        /HTTP 403|invalid model entry/,
      );
      assert.ok(!connection.state.reason?.includes("private response body"));
    }
  });

  test("stopped or replaced session ignores stale catalog completion", async () => {
    const connection = new DevTunnelConnection();
    let release!: (response: Response) => void;
    const checking = connection.check("https://old.example.test", undefined, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    connection.reset();
    assert.deepStrictEqual(connection.state, { status: "inactive" });
    await connection.check("https://new.example.test", undefined, {
      fetchImpl: async () => Response.json({ version: 1, models: [] }),
    });
    release(Response.json({ version: 1, models: [] }));
    assert.strictEqual(await checking, false);
    assert.deepStrictEqual(connection.state, {
      status: "connected",
      url: "https://new.example.test",
      modelCount: 0,
    });
    let releaseStopped!: (response: Response) => void;
    const stopped = connection.check("https://new.example.test", undefined, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          releaseStopped = resolve;
        }),
    });
    connection.reset();
    releaseStopped(Response.json({ version: 1, models: [] }));
    assert.strictEqual(await stopped, false);
    assert.deepStrictEqual(connection.state, { status: "inactive" });
  });

  test("failed stop keeps a live host manageable and ignores its pending catalog check", async () => {
    const connection = new DevTunnelConnection();
    const url = "https://example.test";
    let release!: (response: Response) => void;
    const checking = connection.check(url, undefined, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    let rejectStop!: (error: Error) => void;
    const host = {
      active: true,
      stop: () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject;
        }),
    };
    const stopping = connection.stop(host);
    release(Response.json({ version: 1, models: [] }));
    assert.strictEqual(await checking, false);
    const error = new Error("Host is still running");
    rejectStop(error);
    await assert.rejects(stopping, error);
    assert.strictEqual(host.active, true);
    assert.deepStrictEqual(connection.state, { status: "stopFailed", url });
    assert.deepStrictEqual(
      shareActionItems(connection.state.url, true).map((item) => item.id),
      ["copyUrl", "copySetup", "stop", "setKey", "removeKey"],
    );
    assert.strictEqual(
      statusItems(health(), "info", connection.state).find(
        (item) => item.action === "share",
      )?.label,
      "$(radio-tower) Manage sharing via dev tunnel",
    );
  });

  test("successful stop clears sharing and ignores late catalog completion", async () => {
    const connection = new DevTunnelConnection();
    let release!: (response: Response) => void;
    const checking = connection.check("https://example.test", undefined, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const host = {
      active: true,
      stop: async () => {
        host.active = false;
      },
    };
    await connection.stop(host);
    assert.strictEqual(host.active, false);
    assert.deepStrictEqual(connection.state, { status: "inactive" });
    release(Response.json({ version: 1, models: [] }));
    assert.strictEqual(await checking, false);
    assert.deepStrictEqual(connection.state, { status: "inactive" });
  });

  test("failed stop cannot be revived by a late catalog completion", async () => {
    const connection = new DevTunnelConnection();
    const url = "https://example.test";
    let release!: (response: Response) => void;
    const checking = connection.check(url, undefined, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await assert.rejects(
      connection.stop({
        active: true,
        stop: async () => {
          throw new Error("Host is still running");
        },
      }),
      /Host is still running/,
    );
    release(Response.json({ version: 1, models: [] }));
    assert.strictEqual(await checking, false);
    assert.deepStrictEqual(connection.state, { status: "stopFailed", url });
  });

  test("selecting sharing dispatches the supplied sharing handler", async () => {
    const showQuickPick = vscode.window.showQuickPick;
    let calls = 0;
    Object.assign(vscode.window, {
      showQuickPick: async () =>
        statusItems(health()).find((i) => i.action === "share"),
    });
    try {
      await showStatus(
        { health, nativeModels: () => [] } as unknown as Gateway,
        {
          share: async () => {
            calls++;
          },
        } as unknown as Parameters<typeof showStatus>[1],
      );
      assert.strictEqual(calls, 1);
    } finally {
      Object.assign(vscode.window, { showQuickPick });
    }
  });

  test("reads owned lifecycle state, not a saved tunnel URL", async () => {
    const showErrorMessage = vscode.window.showErrorMessage;
    Object.assign(vscode.window, { showErrorMessage: async () => undefined });
    const context = {
      subscriptions: [],
      globalState: {
        get: () => {
          throw new Error("Saved URL must not determine sharing state");
        },
      },
    } as unknown as vscode.ExtensionContext;
    try {
      assert.strictEqual(devTunnelSharingState().status, "inactive");
      const starting = shareViaDevTunnel(context, {
        port: undefined,
        state: "Disabled",
      } as Gateway);
      assert.strictEqual(devTunnelSharingState().status, "starting");
      await starting;
      assert.strictEqual(devTunnelSharingState().status, "inactive");
      assert.ok(
        statusItems(health()).some(
          (i) => i.label === "Dev tunnel sharing: Inactive",
        ),
      );
    } finally {
      Object.assign(vscode.window, { showErrorMessage });
      context.subscriptions.forEach((s) => s.dispose());
    }
  });
});

suite("commands/status models", () => {
  test("Models row opens searchable native local and remote models and copies the ID", async () => {
    const showQuickPick = vscode.window.showQuickPick;
    const showInformationMessage = vscode.window.showInformationMessage;
    const clipboard = await vscode.env.clipboard.readText();
    const models = [
      {
        id: "office--remote-model",
        displayName: "Remote model",
        remote: "office",
      },
      { id: "local-model", displayName: "Local model" },
    ] as ReturnType<Gateway["nativeModels"]>;
    let picks = 0;
    let notification: string | undefined;
    Object.assign(vscode.window, {
      showQuickPick: async (
        items: (vscode.QuickPickItem & { action?: string })[],
        options: vscode.QuickPickOptions,
      ) => {
        picks++;
        if (picks === 1) {
          const row = items.find((i) => i.action === "models");
          assert.strictEqual(row?.label, "Models: 2");
          return row;
        }
        assert.strictEqual(options.matchOnDescription, true);
        assert.strictEqual(options.matchOnDetail, true);
        assert.deepStrictEqual(items, [
          { label: "local-model", description: "Local", detail: "Local model" },
          {
            label: "office--remote-model",
            description: "Remote: office",
            detail: "Remote model",
          },
        ]);
        return items[1];
      },
      showInformationMessage: async (message: string) => {
        notification = message;
      },
    });
    try {
      await showStatus(
        { health, nativeModels: () => [...models] } as unknown as Gateway,
        {} as Parameters<typeof showStatus>[1],
      );
      assert.strictEqual(picks, 2);
      assert.strictEqual(
        await vscode.env.clipboard.readText(),
        "office--remote-model",
      );
      assert.strictEqual(notification, "Model ID copied: office--remote-model");
    } finally {
      Object.assign(vscode.window, { showQuickPick, showInformationMessage });
      await vscode.env.clipboard.writeText(clipboard);
    }
  });

  test("empty discovery and cancelling the model picker leave the clipboard unchanged", async () => {
    const showQuickPick = vscode.window.showQuickPick;
    const showInformationMessage = vscode.window.showInformationMessage;
    const clipboard = await vscode.env.clipboard.readText();
    const notifications: string[] = [];
    try {
      for (const models of [
        [],
        [{ id: "local-model", displayName: "Local model" }],
      ]) {
        let picks = 0;
        Object.assign(vscode.window, {
          showQuickPick: async (items: { action?: string }[]) => {
            picks++;
            return picks === 1
              ? items.find((i) => i.action === "models")
              : undefined;
          },
          showInformationMessage: async (message: string) => {
            notifications.push(message);
          },
        });
        await showStatus(
          { health, nativeModels: () => models } as unknown as Gateway,
          {} as Parameters<typeof showStatus>[1],
        );
        assert.strictEqual(picks, models.length === 0 ? 1 : 2);
        assert.strictEqual(await vscode.env.clipboard.readText(), clipboard);
      }
      assert.deepStrictEqual(notifications, ["No models discovered yet."]);
    } finally {
      Object.assign(vscode.window, { showQuickPick, showInformationMessage });
      await vscode.env.clipboard.writeText(clipboard);
    }
  });
});

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
        { health, nativeModels: () => [] } as unknown as Gateway,
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
