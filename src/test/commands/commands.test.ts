import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { piAdapter } from "../../clients/ompPi";
import type { ClientConfigInput } from "../../clients/types";
import {
  clientActions,
  clientConfigState,
  clientItemDescription,
  pickedByDefault,
} from "../../commands/clients";
import { fallbackModelItems } from "../../commands/fallback";
import { listeningOn, validatePort } from "../../commands/port";
import { remoteListItems, remoteStateText } from "../../commands/remotes";
import { shareActionItems } from "../../commands/share";
import { RECENT_ERRORS_SHOWN, statusItems } from "../../commands/status";
import { webSearchEngineItems } from "../../commands/webSearch";
import type { HealthSnapshot } from "../../gateway/health";
import { WEB_SEARCH_ENGINES } from "../../protocol/hosted/catalog";

const ROOT = path.resolve(__dirname, "../../..");
const CMD = "agentGateway.";

function health(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: "Ready",
    bridgeVersion: "1",
    buildTime: "unbundled",
    listener: { active: true, address: "http://127.0.0.1:4141" },
    vscodeVersion: "1",
    copilot: { installed: true, active: true },
    modelCount: 3,
    lastDiscoveryTime: null,
    lastStartupError: null,
    remotes: [],
    fallbackModel: "gpt-6-astra",
    fallbackModelSource: "default",
    errors: { counts: {}, recent: [] },
    ...over,
  };
}

suite("commands/palette", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as {
    contributes: {
      commands: { command: string; title: string }[];
      menus: { commandPalette: { command: string; when: string }[] };
    };
  };
  const hidden = new Set(
    pkg.contributes.menus.commandPalette
      .filter((m) => m.when === "false")
      .map((m) => m.command),
  );
  const hiddenIds = [
    "setApiKey",
    "setRemoteApiKey",
    "copyHealth",
    "openErrorLog",
    "addRemoteUpstream",
    "removeRemoteUpstream",
    "unconfigureClients",
    "setWebSearchApiKey",
  ].map((c) => CMD + c);

  test("visible palette commands are exactly the eight consolidated ones", () => {
    const visible = pkg.contributes.commands
      .filter((c) => !hidden.has(c.command))
      .map((c) => `${c.command}=${c.title}`)
      .sort();
    assert.deepStrictEqual(
      visible,
      [
        "showStatus=Status",
        "restart=Restart Gateway",
        "changePort=Change Port",
        "setFallbackModel=Set Fallback Model",
        "configureClients=Configure Coding Agents",
        "setWebSearchEngine=Web Search and Fetch",
        "shareViaDevTunnel=Share Gateway via Dev Tunnel",
        "manageRemoteUpstreams=Manage Remote Upstreams",
      ]
        .map((c) => CMD + c)
        .sort(),
    );
  });

  test("hidden ids stay contributed, hidden and registered", () => {
    const source = fs
      .readdirSync(path.join(ROOT, "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.includes("test"))
      .map((f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8"))
      .join("\n");
    const registered = new Set(
      [...source.matchAll(/registerCommand\(\s*`\$\{CMD\}\.(\w+)`/g)].map(
        (m) => CMD + m[1],
      ),
    );
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const id of hiddenIds) {
      assert.ok(contributed.has(id), `${id} contributed`);
      assert.ok(hidden.has(id), `${id} hidden`);
      assert.ok(registered.has(id), `${id} registered`);
    }
    for (const id of contributed) {
      if (id.startsWith(CMD)) {
        assert.ok(registered.has(id), `${id} registered`);
      }
    }
  });

  test("every command uses the Agent Gateway category", () => {
    for (const c of pkg.contributes.commands as {
      command: string;
      category?: string;
    }[]) {
      assert.strictEqual(c.category, "Agent Gateway", c.command);
    }
  });
});

suite("commands/status", () => {
  test("lists state, remotes, recent errors and every action", () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({
      time: `t${i}`,
      requestId: `r${i}`,
      protocol: "anthropic",
      method: "POST",
      path: "/v1/messages",
      status: 502,
      kind: "upstream",
      model: "m",
      elapsedMs: 5,
    }));
    const items = statusItems(
      health({
        lastStartupError: "boom",
        remotes: [
          { name: "a", url: "u", status: "ready", modelCount: 2 },
          { name: "b", url: "u", status: "skipped", reason: "401" },
        ],
        errors: { counts: {}, recent },
      }),
    );
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("Remote a: ready, 2 models"));
    assert.ok(labels.includes("Remote b: skipped: 401"));
    assert.ok(labels.includes("Last startup error: boom"));
    assert.ok(labels.includes("502 upstream m"));
    assert.strictEqual(
      items.filter((i) => i.description?.startsWith("request ")).length,
      RECENT_ERRORS_SHOWN,
    );
    assert.deepStrictEqual(
      items.filter((i) => i.action).map((i) => i.action),
      [
        "restart",
        "changePort",
        "fallbackModel",
        "copyHealth",
        "openErrorLog",
        "showLog",
        "logLevel",
        "setApiKey",
        "remotes",
        "webSearch",
        "clients",
      ],
    );
  });

  test("shows current log level beside its action", () => {
    assert.strictEqual(
      statusItems(health(), "debug").find((i) => i.action === "logLevel")
        ?.description,
      "Current: debug",
    );
  });

  test("shows the fallback model and its source", () => {
    const line = statusItems(health()).find((i) =>
      i.label.startsWith("Fallback model:"),
    );
    assert.strictEqual(line?.label, "Fallback model: gpt-6-astra");
    assert.strictEqual(line?.description, "default");
    assert.ok(
      statusItems(
        health({ fallbackModel: null, fallbackModelSource: null }),
      ).some(
        (i) =>
          i.label === "Fallback model: none — set agentGateway.fallbackModel",
      ),
    );
  });

  test("fallback model picker items", () => {
    const models = [
      { id: "gpt-5", displayName: "GPT-5" },
      { id: "claude-x", displayName: "claude-x" },
      { id: "box--gpt-9", displayName: "r", remote: "box" },
      { id: "gateway-claude-gpt-5", displayName: "a", isAlias: true },
    ];
    const items = fallbackModelItems(models, {
      id: "gpt-5",
      source: "setting",
    });
    assert.deepStrictEqual(
      items.map((i) => [i.id, i.description, i.detail]),
      [
        ["", undefined, undefined],
        ["", "Review suggestions for agent default models", undefined],
        [
          "claude-haiku-5.5",
          "(empty — no mapping)",
          "Choose a different target or clear this mapping. Does not change the fallback.",
        ],
        [
          "claude-sonnet-5",
          "(empty — no mapping)",
          "Choose a different target or clear this mapping. Does not change the fallback.",
        ],
        ["box--gpt-9", undefined, "r"],
        ["claude-x", undefined, undefined],
        ["gpt-5", "current (setting)", "GPT-5"],
      ],
    );
    const remote = fallbackModelItems(models, {
      id: "box--gpt-9",
      source: "setting",
    });
    assert.strictEqual(
      remote.find((i) => i.id === "box--gpt-9")?.description,
      "current (setting)",
    );
    assert.strictEqual(items[1].action, "initializeMappings");
    const def = fallbackModelItems(models, { id: null, source: null });
    assert.strictEqual(def[0].description, "current");
    assert.strictEqual(def[0].label, "Use default (gpt-6-astra if available)");
  });

  test("no error section without errors", () => {
    assert.ok(!statusItems(health()).some((i) => i.label === "Recent errors"));
  });
});

suite("commands/remotes", () => {
  test("add item first, then remotes with their state", () => {
    const items = remoteListItems(
      [
        { name: "a", url: "https://a" },
        { name: "c", url: "https://c" },
      ],
      [{ name: "a", url: "https://a", status: "ready", modelCount: 1 }],
    );
    assert.strictEqual(items[0].name, undefined);
    assert.match(items[0].label, /Add remote upstream/);
    assert.deepStrictEqual(
      items.slice(1).map((i) => [i.name, i.description, i.detail]),
      [
        ["a", "ready, 1 model", "https://a"],
        ["c", "not loaded yet", "https://c"],
      ],
    );
    assert.strictEqual(remoteStateText(undefined), "not loaded yet");
  });
});

suite("commands/share", () => {
  test("offers copy actions only with a URL and remove only with a key", () => {
    assert.deepStrictEqual(
      shareActionItems("https://x", true).map((i) => i.id),
      ["copyUrl", "copySetup", "stop", "setKey", "removeKey"],
    );
    assert.deepStrictEqual(
      shareActionItems(undefined, false).map((i) => i.id),
      ["stop", "setKey"],
    );
  });
});

suite("commands/webSearch", () => {
  test("marks the current engine and describes anonymous use", () => {
    const items = webSearchEngineItems("exa");
    assert.strictEqual(items.length, WEB_SEARCH_ENGINES.length + 1);
    assert.strictEqual(
      items.find((i) => i.id === "exa")?.description,
      "current",
    );
    for (const e of WEB_SEARCH_ENGINES) {
      const detail = items.find((i) => i.id === e.id)?.detail ?? "";
      assert.ok(
        detail.includes(
          e.fetchAnonymous
            ? "URL fetch works without a key"
            : "URL fetch requires an API key",
        ),
      );
      assert.ok(
        detail.includes(e.anonymous ? "search works" : "search requires"),
      );
    }
  });
});

suite("commands/clients", () => {
  const input: ClientConfigInput = {
    gatewayUrl: "http://127.0.0.1:4141",
    models: [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        contextWindow: 1000,
        inputModalities: ["text"],
        supportsToolCalling: true,
        reasoning: false,
      },
    ],
    defaultModel: "gpt-5",
    home: "/home/u",
    platform: "linux",
  };

  test("detects not configured, up to date and outdated", () => {
    const files: Record<string, string | undefined> = {};
    for (const p of piAdapter.configPaths(input.home, input.platform)) {
      files[p] = undefined;
    }
    assert.strictEqual(
      clientConfigState(piAdapter, input, files),
      "not configured",
    );
    for (const c of piAdapter.plan(input, files).changes) {
      files[c.path] = c.after;
    }
    assert.strictEqual(
      clientConfigState(piAdapter, input, files),
      "up to date",
    );
    assert.strictEqual(
      clientConfigState(
        piAdapter,
        { ...input, gatewayUrl: "http://127.0.0.1:5000" },
        files,
      ),
      "configured",
    );
  });

  test("describes items; model-list update only for static clients", () => {
    assert.strictEqual(
      clientItemDescription(true, "auto", "up to date"),
      "up to date · installed · auto discovery",
    );
    assert.strictEqual(
      clientItemDescription(false, "static", "configured"),
      "configured (outdated) · writes model list",
    );
    assert.deepStrictEqual(clientActions([piAdapter]), [
      "configure",
      "updateModels",
      "unconfigure",
    ]);
  });

  test("only agents already set up for the gateway are pre-ticked", () => {
    assert.strictEqual(pickedByDefault("configured"), true);
    assert.strictEqual(pickedByDefault("up to date"), true);
    assert.strictEqual(pickedByDefault("not configured"), false);
    assert.strictEqual(pickedByDefault(undefined), false);
  });
});

suite("commands/port", () => {
  test("validates the new port", () => {
    assert.strictEqual(validatePort("25000", 24444), undefined);
    assert.match(validatePort("abc", 24444) ?? "", /whole number/);
    assert.match(validatePort("80", 24444) ?? "", /1024/);
    assert.match(validatePort("70000", 24444) ?? "", /65535/);
    assert.match(validatePort("24444", 24444) ?? "", /current/);
    assert.match(validatePort("24445", 24444) ?? "", /development/);
  });

  test("waits for the gateway to listen on the new port", async () => {
    let port: number | undefined = 24444;
    const listeners: (() => void)[] = [];
    const gw = {
      get port() {
        return port;
      },
      onDidChangeStatus: (fn: () => void) => {
        listeners.push(fn);
        return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
      },
    } as unknown as Parameters<typeof listeningOn>[0];
    const ready = listeningOn(gw, 25000, 1000);
    port = 25000;
    listeners.forEach((l) => l());
    assert.strictEqual(await ready, true);
    assert.strictEqual(listeners.length, 0);
    assert.strictEqual(await listeningOn(gw, 26000, 10), false);
  });
});
