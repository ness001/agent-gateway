import * as assert from "assert";
import { parse as parseYaml } from "yaml";

import { ompAdapter, piAdapter } from "../../clients/ompPi";
import {
  type ClientConfigInput,
  type GatewayModel,
  PLACEHOLDER_API_KEY,
} from "../../clients/types";

const models: GatewayModel[] = [
  {
    id: "gpt-5",
    displayName: "GPT-5",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputModalities: ["text", "image", "audio"],
    supportsToolCalling: true,
    reasoning: true,
  },
  {
    id: "claude-sonnet",
    displayName: "Claude Sonnet",
    contextWindow: null,
    inputModalities: ["text"],
    supportsToolCalling: null,
    reasoning: false,
  },
  {
    id: "no-tools",
    displayName: "x",
    contextWindow: 1,
    inputModalities: ["text"],
    supportsToolCalling: false,
    reasoning: false,
  },
  {
    id: "copilot-utility-small",
    displayName: "u",
    contextWindow: 1,
    inputModalities: ["text"],
    supportsToolCalling: true,
    reasoning: false,
  },
];

function input(over: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    gatewayUrl: "http://127.0.0.1:24444",
    models,
    defaultModel: "gpt-5",
    home: "C:\\Users\\me",
    platform: "win32",
    ...over,
  };
}

const ompYml = "C:\\Users\\me\\.omp\\agent\\models.yml";
const ompYaml = "C:\\Users\\me\\.omp\\agent\\models.yaml";
const ompConfig = "C:\\Users\\me\\.omp\\agent\\config.yml";
const ompConfigYaml = "C:\\Users\\me\\.omp\\agent\\config.yaml";
const ompBackup = "C:\\Users\\me\\.omp\\agent\\agent-gateway-default.json";
const piJson = "C:\\Users\\me\\.pi\\agent\\models.json";
const piSettings = "C:\\Users\\me\\.pi\\agent\\settings.json";
const piBackup = "C:\\Users\\me\\.pi\\agent\\agent-gateway-default.json";

suite("omp adapter", () => {
  test("metadata and paths", () => {
    assert.strictEqual(ompAdapter.id, "omp");
    assert.strictEqual(ompAdapter.discovery, "auto");
    assert.deepStrictEqual(ompAdapter.configPaths("C:\\Users\\me", "win32"), [
      ompYml,
      ompYaml,
      ompConfig,
      ompConfigYaml,
      ompBackup,
    ]);
    assert.deepStrictEqual(ompAdapter.configPaths("/home/me", "linux"), [
      "/home/me/.omp/agent/models.yml",
      "/home/me/.omp/agent/models.yaml",
      "/home/me/.omp/agent/config.yml",
      "/home/me/.omp/agent/config.yaml",
      "/home/me/.omp/agent/agent-gateway-default.json",
    ]);
  });

  test("creates models.yml with discovery provider and placeholder key", () => {
    const plan = ompAdapter.plan(input(), {});
    assert.strictEqual(plan.changes.length, 3);
    assert.deepStrictEqual(
      JSON.parse(plan.changes.find((c) => c.path === ompBackup)!.after!),
      {
        model: null,
        configExisted: false,
      },
    );
    assert.strictEqual(
      parseYaml(plan.changes.find((c) => c.path === ompConfig)!.after!)
        .modelRoles.default,
      "agent-gateway/gpt-5",
    );
    const after = plan.changes.find((c) => c.path === ompYml)!.after!;
    assert.match(after, /agent-gateway:/);
    assert.match(after, /baseUrl: http:\/\/127\.0\.0\.1:24444\/v1/);
    assert.match(after, new RegExp(`apiKey: ${PLACEHOLDER_API_KEY}`));
    assert.match(after, /api: openai-responses/);
    assert.match(after, /type: openai-models-list/);
    assert.match(after, /injectV1: false/);
  });

  test("preserves comments and other providers, idempotent, edits models.yaml when alone", () => {
    const before =
      "# my config\nproviders:\n  other:\n    # keep\n    baseUrl: http://x\n";
    const configBefore =
      "# settings\nmodelRoles:\n  default: other/m\n  compaction: other/s\n";
    const files = { [ompYaml]: before, [ompConfigYaml]: configBefore };
    const plan = ompAdapter.plan(input({ apiKey: "k" }), files);
    const after = plan.changes.find((c) => c.path === ompYaml)!.after!;
    assert.ok(after.startsWith("# my config\n"));
    assert.match(after, /other:\n {4}# keep/);
    assert.match(after, /apiKey: k/);
    const configAfter = plan.changes.find(
      (c) => c.path === ompConfigYaml,
    )!.after!;
    assert.ok(configAfter.includes("# settings"));
    assert.strictEqual(parseYaml(configAfter).modelRoles.compaction, "other/s");
    const applied = {
      [ompYaml]: after,
      [ompConfigYaml]: configAfter,
      [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
    };
    const again = ompAdapter.plan(input({ apiKey: "k" }), applied);
    assert.strictEqual(again.changes.length, 0);

    const un = ompAdapter.unplan(input(), applied);
    assert.strictEqual(
      un.changes.find((c) => c.path === ompYaml)?.after,
      before,
    );
    assert.strictEqual(
      un.changes.find((c) => c.path === ompConfigYaml)?.after,
      configBefore,
    );
    assert.strictEqual(
      un.changes.find((c) => c.path === ompBackup)?.after,
      undefined,
    );
  });

  test("keeps an existing empty global config when removing the default", () => {
    const plan = ompAdapter.plan(input(), { [ompConfig]: "{}\n" });
    const removed = ompAdapter.unplan(input(), {
      [ompYml]: plan.changes.find((c) => c.path === ompYml)?.after,
      [ompConfig]: plan.changes.find((c) => c.path === ompConfig)?.after,
      [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
    });
    const restored = removed.changes.find((c) => c.path === ompConfig)?.after;
    assert.notStrictEqual(restored, undefined);
    assert.deepStrictEqual(parseYaml(restored!), {});
  });

  test("prefers models.yml over models.yaml", () => {
    const plan = ompAdapter.plan(input(), {
      [ompYml]: "a: 1\n",
      [ompYaml]: "b: 2\n",
    });
    assert.strictEqual(
      plan.changes.find((c) => c.path === ompYml)?.path,
      ompYml,
    );
  });

  test("reconfigure keeps omp's original default role", () => {
    const before = "modelRoles:\n  default: other/old\n";
    const first = ompAdapter.plan(input(), { [ompConfig]: before });
    const updated = ompAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [ompYml]: first.changes.find((c) => c.path === ompYml)?.after,
      [ompConfig]: first.changes.find((c) => c.path === ompConfig)?.after,
      [ompBackup]: first.changes.find((c) => c.path === ompBackup)?.after,
    });
    const newConfig = updated.changes.find((c) => c.path === ompConfig)!.after!;
    assert.strictEqual(
      parseYaml(newConfig).modelRoles.default,
      "agent-gateway/claude-sonnet",
    );
    const restored = ompAdapter.unplan(input(), {
      [ompYml]: first.changes.find((c) => c.path === ompYml)?.after,
      [ompConfig]: newConfig,
      [ompBackup]: first.changes.find((c) => c.path === ompBackup)?.after,
    });
    assert.strictEqual(
      parseYaml(restored.changes.find((c) => c.path === ompConfig)!.after!)
        .modelRoles.default,
      "other/old",
    );
  });

  test("does not remove the provider or backup when the global config cannot be parsed", () => {
    const plan = ompAdapter.plan(input(), {});
    const files = {
      [ompYml]: plan.changes.find((c) => c.path === ompYml)?.after,
      [ompConfig]: "modelRoles: [broken\n",
      [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
    };
    assert.throws(
      () => ompAdapter.unplan(input(), files),
      /Cannot safely restore/,
    );
    assert.ok(files[ompYml]?.includes("agent-gateway"));
    assert.ok(files[ompBackup]);
  });

  test("upgrades a legacy gateway default without inventing a previous role", () => {
    const legacy = "modelRoles:\n  default: agent-gateway/gpt-5\n";
    const updated = ompAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [ompConfig]: legacy,
    });
    assert.ok(!updated.changes.some((c) => c.path === ompBackup));
    const current = updated.changes.find((c) => c.path === ompConfig)!.after!;
    const removed = ompAdapter.unplan(input(), { [ompConfig]: current });
    assert.strictEqual(
      parseYaml(removed.changes.find((c) => c.path === ompConfig)!.after!)
        ?.modelRoles,
      undefined,
    );
  });

  test("rejects malformed model roles instead of discarding the backup", () => {
    const plan = ompAdapter.plan(input(), {});
    assert.throws(
      () =>
        ompAdapter.unplan(input(), {
          [ompConfig]: "modelRoles: []\n",
          [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
        }),
      /modelRoles must be a mapping/,
    );
  });

  test("rejects malformed provider YAML before restoring the default", () => {
    const plan = ompAdapter.plan(input(), {});
    assert.throws(
      () =>
        ompAdapter.unplan(input(), {
          [ompYml]: "providers: [broken\n",
          [ompConfig]: plan.changes.find((c) => c.path === ompConfig)?.after,
          [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
        }),
      /not a YAML mapping/,
    );
  });

  test("keeps unrelated role YAML byte-for-byte when no restoration is needed", () => {
    const original = "modelRoles: {default: other/new}\n";
    const plan = ompAdapter.plan(input(), {
      [ompConfig]: "modelRoles: {default: other/old}\n",
    });
    const removed = ompAdapter.unplan(input(), {
      [ompConfig]: original,
      [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
    });
    assert.ok(!removed.changes.some((c) => c.path === ompConfig));
  });

  test("unplan of a file plan() created deletes it", () => {
    const plan = ompAdapter.plan(input(), {});
    const un = ompAdapter.unplan(input(), {
      [ompYml]: plan.changes.find((c) => c.path === ompYml)?.after,
      [ompConfig]: plan.changes.find((c) => c.path === ompConfig)?.after,
      [ompBackup]: plan.changes.find((c) => c.path === ompBackup)?.after,
    });
    assert.strictEqual(
      un.changes.find((c) => c.path === ompYml)?.after,
      undefined,
    );
    assert.strictEqual(
      un.changes.find((c) => c.path === ompConfig)?.after,
      undefined,
    );
    assert.strictEqual(
      un.changes.find((c) => c.path === ompBackup)?.after,
      undefined,
    );
  });
});

suite("pi adapter", () => {
  test("metadata and posix path", () => {
    assert.strictEqual(piAdapter.id, "pi");
    assert.strictEqual(piAdapter.discovery, "static");
    assert.deepStrictEqual(piAdapter.configPaths("/home/me", "darwin"), [
      "/home/me/.pi/agent/models.json",
      "/home/me/.pi/agent/settings.json",
      "/home/me/.pi/agent/agent-gateway-default.json",
    ]);
  });

  test("writes filtered static model list", () => {
    const plan = piAdapter.plan(input(), {});
    const cfg = JSON.parse(plan.changes.find((c) => c.path === piJson)!.after!);
    const p = cfg.providers["agent-gateway"];
    assert.deepStrictEqual(
      JSON.parse(plan.changes.find((c) => c.path === piSettings)!.after!),
      {
        defaultProvider: "agent-gateway",
        defaultModel: "gpt-5",
      },
    );
    assert.deepStrictEqual(
      JSON.parse(plan.changes.find((c) => c.path === piBackup)!.after!),
      {
        provider: null,
        model: null,
        configExisted: false,
      },
    );
    assert.strictEqual(p.baseUrl, "http://127.0.0.1:24444/v1");
    assert.strictEqual(p.api, "openai-responses");
    assert.strictEqual(p.apiKey, PLACEHOLDER_API_KEY);
    assert.deepStrictEqual(p.models, [
      {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 128000,
      },
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  test("keeps comments/other providers, refreshes list, idempotent, unplan restores", () => {
    const before =
      '{\n  // note\n  "providers": {\n    "other": { "baseUrl": "http://x" }\n  }\n}\n';
    const settingsBefore =
      '{\n  "theme": "dark",\n  "defaultProvider": "other",\n  "defaultModel": "m"\n}\n';
    const plan = piAdapter.plan(input({ apiKey: "k" }), {
      [piJson]: before,
      [piSettings]: settingsBefore,
    });
    const after = plan.changes.find((c) => c.path === piJson)!.after!;
    const settingsAfter = plan.changes.find(
      (c) => c.path === piSettings,
    )!.after!;
    const backupAfter = plan.changes.find((c) => c.path === piBackup)!.after!;
    assert.strictEqual(JSON.parse(settingsAfter).defaultModel, "gpt-5");
    assert.strictEqual(JSON.parse(settingsAfter).theme, "dark");
    assert.deepStrictEqual(JSON.parse(backupAfter), {
      provider: "other",
      model: "m",
      configExisted: true,
    });
    assert.match(after, /\/\/ note/);
    assert.match(after, /"other"/);
    assert.strictEqual(
      piAdapter.plan(input({ apiKey: "k" }), {
        [piJson]: after,
        [piSettings]: settingsAfter,
        [piBackup]: backupAfter,
      }).changes.length,
      0,
    );

    const refreshed = piAdapter
      .plan(
        input({ apiKey: "k", models: [models[1]], defaultModel: models[1].id }),
        {
          [piJson]: after,
          [piSettings]: settingsAfter,
          [piBackup]: backupAfter,
        },
      )
      .changes.find((c) => c.path === piJson)!.after!;
    assert.ok(!refreshed.includes("gpt-5"));

    const un = piAdapter.unplan(input(), {
      [piJson]: after,
      [piSettings]: settingsAfter,
      [piBackup]: backupAfter,
    }).changes;
    const restoredModels = un.find((c) => c.path === piJson)!.after!;
    assert.match(restoredModels, /\/\/ note/);
    assert.match(restoredModels, /"other"/);
    assert.ok(!restoredModels.includes("agent-gateway"));
    assert.deepStrictEqual(
      JSON.parse(un.find((c) => c.path === piSettings)!.after!),
      JSON.parse(settingsBefore),
    );
    assert.strictEqual(un.find((c) => c.path === piBackup)!.after, undefined);
  });

  test("reconfigure keeps the original startup defaults", () => {
    const before = '{"defaultProvider":"other","defaultModel":"old"}\n';
    const first = piAdapter.plan(input(), { [piSettings]: before });
    const updated = piAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [piJson]: first.changes.find((c) => c.path === piJson)?.after,
      [piSettings]: first.changes.find((c) => c.path === piSettings)?.after,
      [piBackup]: first.changes.find((c) => c.path === piBackup)?.after,
    });
    const newSettings = updated.changes.find(
      (c) => c.path === piSettings,
    )!.after!;
    assert.deepStrictEqual(JSON.parse(newSettings), {
      defaultProvider: "agent-gateway",
      defaultModel: "claude-sonnet",
    });
    assert.strictEqual(
      piAdapter
        .unplan(input(), {
          [piJson]: first.changes.find((c) => c.path === piJson)?.after,
          [piSettings]: newSettings,
          [piBackup]: first.changes.find((c) => c.path === piBackup)?.after,
        })
        .changes.find((c) => c.path === piSettings)?.after,
      before,
    );
  });

  test("keeps an existing empty settings file on removal", () => {
    const plan = piAdapter.plan(input(), { [piSettings]: "{}" });
    const changes = piAdapter.unplan(input(), {
      [piJson]: plan.changes.find((c) => c.path === piJson)?.after,
      [piSettings]: plan.changes.find((c) => c.path === piSettings)?.after,
      [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
    }).changes;
    assert.notStrictEqual(
      changes.find((c) => c.path === piSettings)?.after,
      undefined,
    );
    assert.deepStrictEqual(
      JSON.parse(changes.find((c) => c.path === piSettings)!.after!),
      {},
    );
  });

  test("restores Pi's default when models.json is missing", () => {
    const before = '{"defaultProvider":"other","defaultModel":"old"}\n';
    const plan = piAdapter.plan(input(), { [piSettings]: before });
    const changes = piAdapter.unplan(input(), {
      [piSettings]: plan.changes.find((c) => c.path === piSettings)?.after,
      [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
    }).changes;
    assert.strictEqual(
      changes.find((c) => c.path === piSettings)?.after,
      before,
    );
    assert.strictEqual(
      changes.find((c) => c.path === piBackup)?.after,
      undefined,
    );
  });

  test("rejects comments in Pi settings instead of writing unusable JSON", () => {
    assert.throws(() =>
      piAdapter.plan(input(), { [piSettings]: "{ // note\n}" }),
    );
  });

  test("rejects a malformed settings root without deleting the backup", () => {
    const plan = piAdapter.plan(input(), {});
    assert.throws(
      () =>
        piAdapter.unplan(input(), {
          [piJson]: plan.changes.find((c) => c.path === piJson)?.after,
          [piSettings]: "[]",
          [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
        }),
      /settings must be an object/,
    );
  });

  test("upgrades a legacy gateway default without inventing a previous provider", () => {
    const legacy = '{"defaultProvider":"agent-gateway","defaultModel":"gpt-5"}';
    const updated = piAdapter.plan(input({ defaultModel: "claude-sonnet" }), {
      [piSettings]: legacy,
    });
    assert.ok(!updated.changes.some((c) => c.path === piBackup));
    const current = updated.changes.find((c) => c.path === piSettings)!.after!;
    const removed = piAdapter.unplan(input(), { [piSettings]: current });
    assert.deepStrictEqual(
      JSON.parse(removed.changes.find((c) => c.path === piSettings)!.after!),
      {},
    );
  });

  test("rejects malformed provider models instead of discarding the backup", () => {
    const plan = piAdapter.plan(input(), {});
    assert.throws(
      () =>
        piAdapter.unplan(input(), {
          [piJson]: "[]",
          [piSettings]: plan.changes.find((c) => c.path === piSettings)?.after,
          [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
        }),
      /must be an object/,
    );
  });

  test("rejects malformed defaultProvider before deleting the backup", () => {
    const plan = piAdapter.plan(input(), {});
    assert.throws(
      () =>
        piAdapter.unplan(input(), {
          [piSettings]: '{"defaultProvider":[]}',
          [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
        }),
      /defaultProvider must be a string/,
    );
  });

  test("unplan of a file plan() created deletes it; missing file is a no-op", () => {
    const plan = piAdapter.plan(input(), {});
    const changes = piAdapter.unplan(input(), {
      [piJson]: plan.changes.find((c) => c.path === piJson)?.after,
      [piSettings]: plan.changes.find((c) => c.path === piSettings)?.after,
      [piBackup]: plan.changes.find((c) => c.path === piBackup)?.after,
    }).changes;
    assert.strictEqual(
      changes.find((c) => c.path === piJson)?.after,
      undefined,
    );
    assert.strictEqual(
      changes.find((c) => c.path === piSettings)?.after,
      undefined,
    );
    assert.strictEqual(
      changes.find((c) => c.path === piBackup)?.after,
      undefined,
    );
    assert.strictEqual(piAdapter.unplan(input(), {}).changes.length, 0);
  });
});
