import * as assert from "assert";

import { buildRegistry } from "../../gateway/catalog";
import { toModelInfo } from "../../gateway/discovery";
import {
  explainUnknownModel,
  isValidGeminiModelSegment,
  resolveFallbackModel,
  resolveModel,
  resolveModelAlias,
} from "../../gateway/match";
import type { CatalogEntry, RemoteState } from "../../gateway/types";

const local = (...ids: string[]) =>
  buildRegistry(
    ids.map((id) => toModelInfo({ id })),
    [],
  );
const entry = (id: string, upstreamModelId = id): CatalogEntry => ({
  ...toModelInfo({ id }),
  upstreamModelId,
  isAlias: false,
});
const resolveId = (
  reg: CatalogEntry[],
  model: string,
  allowFallback = true,
  fallbackModel?: string,
) => resolveModel(reg, model, { allowFallback, fallbackModel })?.entry.id;

suite("Gateway model matching", () => {
  test("resolves exact and suffixed routes and rejects unknown models", () => {
    const reg = [entry("gpt-5.6-sol[1m]"), entry("claude-opus-5[1m]")];
    assert.strictEqual(
      resolveId(reg, "claude-opus-5[1m]"),
      "claude-opus-5[1m]",
    );
    assert.strictEqual(resolveId(reg, "claude-opus-5"), "claude-opus-5[1m]");
    assert.strictEqual(
      resolveModel(reg, "unknown", { allowFallback: true }),
      undefined,
    );
  });

  for (const model of ["codex-auto-review", "unknown-model"]) {
    test(`uses explicitly selected Astra for ${model}`, () => {
      const astra = entry("gateway-claude-gpt-6-astra[1m]", "gpt-6-astra[1m]");
      const r = resolveModel([astra], model, {
        allowFallback: true,
        fallbackModel: astra.id,
      });
      assert.strictEqual(r?.entry, astra);
      assert.strictEqual(r?.fallback, true);
    });
  }

  test("fallback requires a usable explicit setting even when Astra is available", () => {
    const reg = [
      entry("gpt-5"),
      entry("gpt-6-astra"),
      { ...entry("big"), remote: "box" },
    ];
    const missing: string[] = [];
    const pick = (r: CatalogEntry[], fallbackModel?: string) =>
      resolveModel(r, "unknown", {
        allowFallback: true,
        fallbackModel,
        onMissingFallback: (id) => missing.push(id),
      })?.entry.id;
    assert.strictEqual(pick(reg, "gpt-5"), "gpt-5");
    assert.strictEqual(pick(reg), undefined);
    assert.strictEqual(pick(reg, ""), undefined);
    assert.strictEqual(pick(reg, "  "), undefined);
    assert.strictEqual(pick(reg, "nope"), undefined);
    assert.strictEqual(pick(reg, "big"), "big");
    assert.deepStrictEqual(missing, ["nope"]);
    assert.strictEqual(pick([entry("gpt-5")], ""), undefined);
    assert.strictEqual(pick([entry("gpt-5")], "nope"), undefined);
    assert.strictEqual(
      resolveFallbackModel(reg, { fallbackModel: "gpt-5" })?.source,
      "setting",
    );
    assert.strictEqual(resolveFallbackModel(reg), undefined);
  });

  test("remote fallback respects operations, suffixes and availability", () => {
    const remote = {
      ...entry("box--gpt-5[1m]", "gpt-5[1m]"),
      remote: "box",
      operations: ["openai.responses" as const],
    };
    const reg = [entry("gpt-6-astra"), remote];
    assert.strictEqual(
      resolveFallbackModel(reg, {
        fallbackModel: "box--gpt-5",
        operation: "openai.responses",
      })?.entry,
      remote,
    );
    assert.strictEqual(
      resolveFallbackModel(reg, {
        fallbackModel: remote.id,
        operation: "anthropic.messages",
      }),
      undefined,
    );
    assert.strictEqual(
      resolveFallbackModel([entry("gpt-6-astra")], {
        fallbackModel: remote.id,
      }),
      undefined,
    );
    assert.strictEqual(resolveFallbackModel([remote]), undefined);
  });

  test("does not report fallback for normal routing", () => {
    const astra = entry("gateway-claude-gpt-6-astra[1m]");
    for (const model of [astra.id, "gateway-claude-gpt-6-astra"]) {
      assert.strictEqual(
        resolveModel([astra], model, { allowFallback: true })?.fallback,
        false,
      );
    }
    assert.strictEqual(
      resolveModel([entry("sol")], "unknown", { allowFallback: true }),
      undefined,
    );
  });

  test("preserves exact and suffix routes before configured fallback", () => {
    const reg = [
      entry("gateway-claude-gpt-6-astra[1m]"),
      entry("sol[1m]"),
      entry("codex-auto-review"),
    ];
    assert.strictEqual(resolveId(reg, "sol", true, reg[0].id), "sol[1m]");
    assert.strictEqual(resolveId(reg, "sol[1m]", true, reg[0].id), "sol[1m]");
    assert.strictEqual(
      resolveId(reg, "codex-auto-review", true, reg[0].id),
      "codex-auto-review",
    );
  });

  const failing: [string, CatalogEntry[], string][] = [
    [
      "ambiguous duplicate",
      [
        entry("gateway-claude-gpt-6-astra[1m]"),
        entry("duplicate"),
        entry("duplicate"),
      ],
      "duplicate",
    ],
    ["blank model", [entry("gateway-claude-gpt-6-astra[1m]")], " "],
    ["empty model", [entry("gateway-claude-gpt-6-astra[1m]")], ""],
    [
      "ambiguous fallback",
      [
        entry("gateway-claude-gpt-6-astra[1m]"),
        entry("gateway-claude-gpt-6-astra[1m]"),
      ],
      "unknown",
    ],
  ];
  for (const [name, reg, model] of failing) {
    test(`does not use fallback to hide ${name}`, () => {
      assert.strictEqual(
        resolveModel(reg, model, {
          allowFallback: true,
          fallbackModel: "gateway-claude-gpt-6-astra[1m]",
        }),
        undefined,
      );
    });
  }

  test("collision with generated alias resolves the native ID", () => {
    const reg = local("luna", "gateway-claude-luna");
    assert.strictEqual(
      resolveModel(reg, "gateway-claude-luna", { allowFallback: true })?.entry
        .upstreamModelId,
      "gateway-claude-luna",
    );
  });

  test("keeps exact native and alias Luna routes authoritative", () => {
    const reg = local("gpt-6-astra", "gpt-5.6-luna");
    for (const id of ["gpt-5.6-luna", "gateway-claude-gpt-5.6-luna"]) {
      const r = resolveModel(reg, id, {
        allowFallback: true,
        fallbackModel: "gpt-6-astra",
      });
      assert.strictEqual(r?.entry.id, id);
      assert.strictEqual(r?.entry.upstreamModelId, "gpt-5.6-luna");
      assert.strictEqual(r?.fallback, false);
    }
  });

  test("fallback routes unknown models to the configured model only when allowed", () => {
    const reg = local("gpt-6-astra");
    assert.strictEqual(
      resolveId(reg, "unknown-model", true, "gpt-6-astra"),
      "gpt-6-astra",
    );
    assert.strictEqual(
      resolveId(reg, "unknown-model", false, "gpt-6-astra"),
      undefined,
    );
    assert.strictEqual(
      resolveId(local("gpt-5.6-luna"), "unknown-model"),
      undefined,
    );
  });

  test("resolves only existing suffixed routes and keeps native Astra preferred", () => {
    const reg = local("gpt-6-astra", "gpt-6-astra[1m]", "sol[1m]");
    assert.strictEqual(resolveId(reg, "sol"), "sol[1m]");
    assert.strictEqual(
      resolveId(reg, "unknown", true, "gpt-6-astra"),
      "gpt-6-astra",
    );
    assert.strictEqual(resolveId(reg, "SOL", false), undefined);
    assert.strictEqual(resolveId(reg, "unknown", false), undefined);
  });

  test("never appends an undiscovered suffix or invents an Astra route", () => {
    const reg = local("sol");
    assert.strictEqual(resolveId(reg, "sol[1m]"), undefined);
    assert.strictEqual(resolveId(reg, "unknown"), undefined);
  });

  test("configured fallback prefers the exact ID over a suffixed route", () => {
    const reg = [entry("sol[1m]"), entry("sol")];
    assert.strictEqual(resolveId(reg, "x", true, "sol"), "sol");
    assert.strictEqual(resolveId(reg, "x", true, "sol[1m]"), "sol[1m]");
  });

  test("named remote models resolve explicitly but never as fallback", () => {
    const reg = buildRegistry(
      [],
      [{ name: "devbox", models: [toModelInfo({ id: "gpt-6-astra" })] }],
    );
    const r = resolveModel(reg, "gateway-claude-devbox--gpt-6-astra", {
      allowFallback: true,
    });
    assert.strictEqual(r?.entry.upstreamModelId, "gpt-6-astra");
    assert.strictEqual(r?.entry.remote, "devbox");
    assert.strictEqual(resolveId(reg, "gpt-6-astra"), undefined);
  });

  test("never selects local or remote Astra implicitly", () => {
    const remote: CatalogEntry = { ...entry("gpt-6-astra"), remote: "devbox" };
    assert.strictEqual(resolveId([remote], "unknown"), undefined);
    const localAlias = entry("gateway-claude-gpt-6-astra");
    assert.strictEqual(resolveId([remote, localAlias], "unknown"), undefined);
    assert.strictEqual(
      resolveId([remote, localAlias], "unknown", true, localAlias.id),
      localAlias.id,
    );
  });

  suite("isValidGeminiModelSegment", () => {
    for (const s of ["gemini-3.5-flash", "models_x", "a.b"]) {
      test(`accepts ${s}`, () =>
        assert.strictEqual(isValidGeminiModelSegment(s), true));
    }
    for (const s of [
      "",
      " ",
      "bad/model",
      "bad\\model",
      "bad:model",
      "bad%model",
      "bad​model",
      "bad model",
      "bad?x",
      "bad#x",
      "bad\nx",
      ".",
      "..",
    ]) {
      test(`rejects ${JSON.stringify(s)}`, () =>
        assert.strictEqual(isValidGeminiModelSegment(s), false));
    }
  });

  suite("fallback reasons", () => {
    const astraReg = () => local("gpt-5", "gpt-6-astra");
    const states: RemoteState[] = [
      { name: "devbox", url: "http://d", status: "ready", modelCount: 1 },
      {
        name: "self",
        url: "http://s",
        status: "skipped",
        reason: "points at this gateway\r\nX-Evil: 1",
      },
    ];
    const reason = (id: string, remotes = states) =>
      resolveModel(astraReg(), id, {
        allowFallback: true,
        fallbackModel: "gpt-6-astra",
        remotes,
      })?.reason;

    test("unknown model", () =>
      assert.strictEqual(reason("nope"), "unknown model"));
    test("ready remote that does not advertise the model", () =>
      assert.strictEqual(
        reason("devbox--claude-haiku-5.5"),
        "remote 'devbox' does not advertise model 'claude-haiku-5.5'",
      ));
    test("skipped remote is unavailable with sanitized reason", () =>
      assert.strictEqual(
        reason("self--gpt-5"),
        "remote 'self' is unavailable (points at this gateway X-Evil: 1)",
      ));
    test("prefix looking like a remote name that is not configured", () =>
      assert.strictEqual(
        reason("other--gpt-5"),
        "remote 'other' is not configured",
      ));
    test("non-name prefix stays unknown", () => {
      assert.strictEqual(reason("bad prefix--x"), "unknown model");
      assert.strictEqual(reason("--x"), "unknown model");
    });
    test("default remotes is empty", () =>
      assert.strictEqual(
        resolveModel(astraReg(), "devbox--x", {
          allowFallback: true,
          fallbackModel: "gpt-6-astra",
        })?.reason,
        "remote 'devbox' is not configured",
      ));
    test("explainUnknownModel prefers the longest remote prefix", () =>
      assert.strictEqual(
        explainUnknownModel("a--b--c", [
          { name: "a", url: "u", status: "ready", modelCount: 0 },
          { name: "a--b", url: "u", status: "ready", modelCount: 0 },
        ]),
        "remote 'a--b' does not advertise model 'c'",
      ));
  });
});

suite("Gateway model aliases", () => {
  const gem = (id: string): CatalogEntry => ({
    ...entry(id),
    family: id,
  });
  const op = "gemini.generateContent" as const;

  test("built-in Gemini CLI names pick the highest local version per tier", () => {
    const reg = [
      entry("gpt-6-astra"),
      gem("gemini-2.5-flash-x"),
      gem("gemini-3-flash"),
      gem("gemini-2.5-pro"),
      gem("gemini-3.1-pro-preview"),
      { ...gem("gemini-9-flash"), remote: "box" },
    ];
    const alias = (model: string) =>
      resolveModelAlias(reg, model, { operation: op })?.id;
    assert.strictEqual(alias("gemini-3-flash-preview"), "gemini-3-flash");
    assert.strictEqual(alias("gemini-2.5-flash-lite"), "gemini-3-flash");
    assert.strictEqual(alias("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
    assert.strictEqual(alias("gemini-9-ultra"), undefined);
  });

  test("does not select Astra implicitly when no local Gemini model exists", () => {
    const reg = [entry("gpt-5"), entry("gpt-6-astra")];
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-pro-preview", { operation: op }),
      undefined,
    );
  });

  test("built-in aliases use the fallbackModel setting as last resort", () => {
    const reg = [entry("gpt-5"), entry("gpt-6-astra")];
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-pro-preview", {
        operation: op,
        fallbackModel: "gpt-5",
      })?.id,
      "gpt-5",
    );
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-pro-preview", {
        operation: op,
        fallbackModel: "nope",
      }),
      undefined,
    );
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-pro-preview", {
        operation: op,
        userAliases: { "gemini-3-pro-preview": "gpt-6-astra" },
        fallbackModel: "gpt-5",
      })?.id,
      "gpt-6-astra",
    );
  });

  test("user aliases override and empty values disable defaults", () => {
    const reg = [entry("gpt-5"), entry("gpt-6-astra"), gem("gemini-3-flash")];
    const userAliases = {
      "gemini-3-flash-preview": "gpt-5",
      "gemini-2.5-flash": "",
    };
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-flash-preview", {
        operation: op,
        userAliases,
      })?.id,
      "gpt-5",
    );
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-2.5-flash", {
        operation: op,
        userAliases,
      }),
      undefined,
    );
  });

  test("hosted search prefers the configured search model", () => {
    const reg = [entry("gpt-5"), entry("gpt-6-astra"), gem("gemini-3-flash")];
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-3-flash-preview", {
        operation: op,
        hostedSearch: true,
        searchModel: "gpt-5",
      })?.id,
      "gpt-5",
    );
    assert.strictEqual(
      resolveModelAlias(reg, "gemini-internal", {
        operation: op,
        hostedSearch: true,
      })?.id,
      "gemini-3-flash",
    );
  });
});
