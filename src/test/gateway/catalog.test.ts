import * as assert from "assert";

import {
  buildRegistry,
  createCodexModelsResponse,
  createGatewayCatalog,
  createModelsResponse,
  summarizeModels,
} from "../../gateway/catalog";
import { toModelInfo } from "../../gateway/discovery";
import { CatalogEntry, ModelInfo } from "../../gateway/types";

const m = (id: string, extra: Record<string, unknown> = {}): ModelInfo =>
  toModelInfo({ id, ...extra });
const ids = (reg: CatalogEntry[]) => reg.map((e) => e.id).join("|");

suite("Gateway catalogue", () => {
  suite("buildRegistry", () => {
    test("keeps local IDs and appends aliases", () => {
      const reg = buildRegistry(
        [m("shared", { name: "First" }), m("other")],
        [],
      );
      assert.strictEqual(
        ids(reg),
        "shared|other|gateway-claude-shared|gateway-claude-other",
      );
      assert.strictEqual(reg[2].displayName, "First");
      assert.strictEqual(reg[2].upstreamModelId, "shared");
      assert.deepStrictEqual(
        reg.map((e) => e.isAlias),
        [false, false, true, true],
      );
    });

    test("preserves native IDs that collide with generated aliases", () => {
      const reg = buildRegistry([m("luna"), m("gateway-claude-luna")], []);
      assert.strictEqual(reg.length, 3);
      assert.strictEqual(
        ids(reg),
        "luna|gateway-claude-luna|gateway-claude-gateway-claude-luna",
      );
    });

    test("namespaces named remote models and flags aliases", () => {
      const reg = buildRegistry(
        [],
        [
          {
            name: "devbox",
            models: [m("gpt-6-astra", { name: "Astra" }), m("gpt-5.6-luna")],
          },
        ],
      );
      assert.strictEqual(
        ids(reg),
        "devbox--gpt-6-astra|devbox--gpt-5.6-luna|gateway-claude-devbox--gpt-6-astra|gateway-claude-devbox--gpt-5.6-luna",
      );
      assert.strictEqual(reg[0].displayName, "[devbox] Astra");
      assert.strictEqual(
        reg.map((e) => e.upstreamModelId).join("|"),
        "gpt-6-astra|gpt-5.6-luna|gpt-6-astra|gpt-5.6-luna",
      );
      assert.deepStrictEqual(
        reg.map((e) => e.remote),
        ["devbox", "devbox", "devbox", "devbox"],
      );
      assert.deepStrictEqual(
        reg.map((e) => e.isAlias),
        [false, false, true, true],
      );
    });

    test("earlier entries win on colliding IDs", () => {
      const local = m("devbox--x", { name: "Local" });
      const reg = buildRegistry(
        [local, m("y")],
        [{ name: "devbox", models: [m("x")] }],
      );
      assert.strictEqual(
        ids(reg),
        "devbox--x|y|gateway-claude-devbox--x|gateway-claude-y",
      );
      assert.strictEqual(reg[0].remote, undefined);
      assert.strictEqual(reg[0].upstreamModelId, "devbox--x");
      assert.strictEqual(buildRegistry([], []).length, 0);
    });

    test("does not mutate inputs and aliases share reasoning metadata", () => {
      const local = m("future", {
        configurationSchema: {
          properties: { reasoningEffort: { enum: ["low", "max"] } },
        },
      });
      const reg = buildRegistry([local], []);
      assert.strictEqual(local.id, "future");
      assert.strictEqual(
        reg[1].supportedReasoningLevels.map((l) => l.effort).join("|"),
        "low|max",
      );
      reg[1].inputModalities.push("audio");
      assert.deepStrictEqual(reg[0].inputModalities, ["text"]);
    });
  });

  suite("createModelsResponse", () => {
    test("creates the Models API response in registry order", () => {
      const reg = buildRegistry(
        [m("gpt-5.6-sol[1m]", { name: "GPT 5.6 Sol (1M)" })],
        [],
      );
      const r = createModelsResponse(reg);
      assert.strictEqual(r.data.length, 2);
      assert.deepStrictEqual(r.data[0], {
        type: "model",
        id: "gpt-5.6-sol[1m]",
        display_name: "GPT 5.6 Sol (1M)",
        created_at: "2026-08-14T00:00:00Z",
        object: "model",
        owned_by: "copilot",
        ...(reg[0].contextWindow !== null
          ? {
              context_length: reg[0].contextWindow,
              context_window: reg[0].contextWindow,
            }
          : {}),
      });
      assert.strictEqual(r.object, "list");
      assert.strictEqual(r.has_more, false);
      assert.strictEqual(r.first_id, "gpt-5.6-sol[1m]");
      assert.strictEqual(r.last_id, "gateway-claude-gpt-5.6-sol[1m]");
    });

    test("supports an empty registry", () => {
      const r = createModelsResponse([]);
      assert.strictEqual(r.data.length, 0);
      assert.strictEqual(r.first_id, null);
    });

    test("owned_by names the remote and context is omitted when unknown", () => {
      const reg = buildRegistry([], [{ name: "box", models: [m("x")] }]);
      reg[0].contextWindow = null;
      const item = createModelsResponse(reg).data[0];
      assert.strictEqual(item.owned_by, "box");
      assert.strictEqual("context_length" in item, false);
    });
  });

  suite("createCodexModelsResponse", () => {
    test("uses discovered context and image capabilities", () => {
      const reg = buildRegistry(
        [
          m("vision", {
            maxInputTokens: 271790,
            capabilities: {
              supportsImageToText: true,
              supportsToolCalling: true,
            },
          }),
          m("text", {
            maxInputTokens: 12078,
            capabilities: { supportsImageToText: false },
          }),
          m("unknown"),
        ],
        [],
      );
      const c = createCodexModelsResponse(reg).models;
      assert.strictEqual(c.length, 3);
      assert.strictEqual(c[0].context_window, 271790);
      assert.strictEqual(c[0].max_context_window, 271790);
      assert.deepStrictEqual(c[0].input_modalities, ["text", "image"]);
      assert.strictEqual(c[1].context_window, 12078);
      assert.strictEqual(c[2].context_window, null);
      assert.deepStrictEqual(
        c.map((x) => x.priority),
        [0, 1, 2],
      );
    });

    test("emits the exact field order and constants", () => {
      const c = createCodexModelsResponse(buildRegistry([m("x")], []))
        .models[0];
      assert.deepStrictEqual(Object.keys(c), [
        "slug",
        "display_name",
        "description",
        "base_instructions",
        "default_reasoning_level",
        "supported_reasoning_levels",
        "shell_type",
        "visibility",
        "supported_in_api",
        "priority",
        "upgrade",
        "support_verbosity",
        "default_verbosity",
        "apply_patch_tool_type",
        "truncation_policy",
        "supports_image_detail_original",
        "input_modalities",
        "context_window",
        "max_context_window",
        "experimental_supported_tools",
      ]);
      assert.strictEqual(c.shell_type, "shell_command");
      assert.deepStrictEqual(c.truncation_policy, {
        mode: "bytes",
        limit: 10000,
      });
      assert.deepStrictEqual(c.experimental_supported_tools, []);
      assert.ok(c.base_instructions.startsWith("You are a coding assistant."));
    });

    test("excludes aliases, non-tool and internal utility models", () => {
      const reg = buildRegistry(
        [
          m("tools", { capabilities: { supportsToolCalling: true } }),
          m("no-tools", { capabilities: { supportsToolCalling: false } }),
          m("copilot-utility"),
          m("copilot-dictation-cleanup"),
        ],
        [],
      );
      assert.deepStrictEqual(
        createCodexModelsResponse(reg).models.map((x) => x.slug),
        ["tools"],
      );
      assert.strictEqual(createModelsResponse(reg).data.length, 8);
    });

    test("filters by upstream identity rather than namespace", () => {
      const reg = buildRegistry(
        [],
        [
          {
            name: "copilot-utility-east",
            models: [
              m("gpt-native"),
              m("copilot-utility"),
              m("no-tools", { capabilities: { supportsToolCalling: false } }),
            ],
          },
        ],
      );
      assert.deepStrictEqual(
        createCodexModelsResponse(reg).models.map((x) => x.slug),
        ["copilot-utility-east--gpt-native"],
      );
    });

    for (const op of [
      "anthropic.messages",
      "openai.chatCompletions",
      "gemini.generateContent",
    ] as const) {
      test(`does not offer models without Responses: ${op}`, () => {
        const reg = buildRegistry([{ ...m("x"), operations: [op] }], []);
        assert.strictEqual(createCodexModelsResponse(reg).models.length, 0);
      });
    }

    test("supports an empty registry and serialises empty reasoning lists as arrays", () => {
      assert.strictEqual(createCodexModelsResponse([]).models.length, 0);
      const reg = buildRegistry(
        [m("a", { supported_reasoning_levels: [] })],
        [],
      );
      const json = JSON.parse(JSON.stringify(createCodexModelsResponse(reg)));
      assert.deepStrictEqual(json.models[0].supported_reasoning_levels, []);
    });
  });

  suite("createGatewayCatalog", () => {
    test("returns version 1 with only the local models", () => {
      const local = [m("a"), m("b")];
      const cat = createGatewayCatalog(local);
      assert.strictEqual(cat.version, 1);
      assert.deepStrictEqual(
        cat.models.map((x) => x.id),
        ["a", "b"],
      );
      assert.notStrictEqual(cat.models[0], local[0]);
    });
  });

  suite("summarizeModels", () => {
    test("prints every model and alias once in family groups with fallback", () => {
      const reg = buildRegistry(
        [
          "gpt-6-astra",
          "gemini-z",
          "claude-z",
          "grok-z",
          "auto",
          "gpt-5.6-luna",
        ].map((id) => m(id)),
        [],
      );
      const lines = summarizeModels(reg);
      assert.strictEqual(lines[0], "Available models: 6 model IDs, 6 aliases");
      for (const h of [
        "GPT (2):",
        "Claude (1):",
        "Gemini (1):",
        "Grok (1):",
        "Other (1):",
        "Aliases (6):",
      ]) {
        assert.ok(lines.includes(h), h);
      }
      for (const e of reg) {
        let expected = "  " + JSON.stringify(e.id);
        if (e.isAlias) {
          expected += " -> " + JSON.stringify(e.upstreamModelId);
        }
        assert.strictEqual(lines.filter((l) => l === expected).length, 1);
      }
      assert.ok(
        lines.indexOf('  "gpt-5.6-luna"') < lines.indexOf('  "gpt-6-astra"'),
      );
      assert.strictEqual(
        lines[lines.length - 1],
        'Unknown-model fallback (non-Gemini): "gpt-6-astra"',
      );
    });

    test("omits empty groups and reports missing fallback", () => {
      const lines = summarizeModels([{ id: "auto", upstreamModelId: "auto" }]);
      assert.deepStrictEqual(lines, [
        "Available models: 1 model IDs, 0 aliases",
        "Other (1):",
        '  "auto"',
        "Unknown-model fallback: unavailable",
      ]);
    });

    test("reports the fallbackModel setting and a missing one", () => {
      const reg = [
        { id: "gpt-5", upstreamModelId: "gpt-5" },
        { id: "gpt-6-astra", upstreamModelId: "gpt-6-astra" },
      ];
      assert.strictEqual(
        summarizeModels(reg, "gpt-5").at(-1),
        'Unknown-model fallback (non-Gemini): "gpt-5"',
      );
      const lines = summarizeModels(reg, "nope");
      assert.deepStrictEqual(lines.slice(-2), [
        'agentGateway.fallbackModel "nope" is not an available local model; using the default fallback.',
        'Unknown-model fallback (non-Gemini): "gpt-6-astra"',
      ]);
    });

    test("escapes terminal controls and newlines", () => {
      const unsafe = "model\nforged\u001b[31m";
      const lines = summarizeModels([
        { id: unsafe, upstreamModelId: unsafe },
        { id: "alias", upstreamModelId: unsafe, isAlias: true },
      ]);
      for (const l of lines) {
        assert.ok(!l.includes("\n") && !l.includes("\u001b"));
      }
      assert.ok(lines.includes('  "alias" -> ' + JSON.stringify(unsafe)));
    });

    test("groups by upstream identity and never advertises a remote fallback", () => {
      const reg = buildRegistry(
        [],
        [{ name: "devbox", models: [m("gpt-6-astra")] }],
      );
      const lines = summarizeModels(reg);
      assert.ok(lines.includes("GPT (1):"));
      assert.strictEqual(
        lines[lines.length - 1],
        "Unknown-model fallback: unavailable",
      );
    });
  });
});
