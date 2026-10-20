import * as assert from "assert";

import {
  InvalidModelMetadataError,
  LanguageModelLike,
  dedupeModels,
  toModelInfo,
  validateModelInfo,
} from "../../gateway/discovery";
import { ALL_OPERATIONS } from "../../gateway/types";

const info = (json: string) =>
  toModelInfo(JSON.parse(json) as LanguageModelLike);
const efforts = (m: { supportedReasoningLevels: { effort: string }[] }) =>
  m.supportedReasoningLevels.map((l) => l.effort).join("|");

suite("Gateway discovery", () => {
  suite("toModelInfo reasoning", () => {
    test("discovers arbitrary schema options and defaults without model matching", () => {
      const a = info(
        '{"id":"future-model-a","vendor":"vendor-a","configurationSchema":{"properties":{"reasoningEffort":{"enum":["low","medium","high","xhigh","max"],"enumItemLabels":["Low","Medium","High","Extra High","Max"],"default":"medium"}}}}',
      );
      assert.strictEqual(efforts(a), "low|medium|high|xhigh|max");
      assert.strictEqual(a.defaultReasoningLevel, "medium");
      assert.strictEqual(
        a.supportedReasoningLevels[3].description,
        "Extra High",
      );
      const b = info(
        '{"id":"another-model","configurationSchema":{"properties":{"reasoningEffort":{"enum":["disabled","adaptive","ultra"],"enumDescriptions":["No thought","Automatic","Deep thought"],"default":"adaptive"}}}}',
      );
      assert.strictEqual(efforts(b), "disabled|adaptive|ultra");
      assert.strictEqual(b.defaultReasoningLevel, "adaptive");
      assert.strictEqual(
        b.supportedReasoningLevels[2].description,
        "Deep thought",
      );
    });

    test("uses the first declared option only when the default is omitted", () => {
      const m = info(
        '{"id":"custom","configurationSchema":{"properties":{"reasoningEffort":{"enum":["minimal","high"]}}}}',
      );
      assert.strictEqual(m.defaultReasoningLevel, "minimal");
      assert.strictEqual(
        m.supportedReasoningLevels[0].description,
        "minimal reasoning effort",
      );
    });

    for (const id of [
      "gpt-6-astra",
      "gpt-5.6-luna",
      "gemini-3.5-flash",
      "auto",
    ]) {
      test(`offers the shared five-option fallback: ${id}`, () => {
        const m = toModelInfo({ id, vendor: "copilot" });
        assert.strictEqual(efforts(m), "low|medium|high|xhigh|max");
        assert.strictEqual(m.defaultReasoningLevel, "medium");
        assert.ok(
          m.supportedReasoningLevels[0].description.includes(
            "support is not advertised",
          ),
        );
      });
    }

    test("honors explicit efforts, defaults, and explicit opt-out over schema", () => {
      const a = info(
        '{"id":"custom","supported_reasoning_levels":[{"effort":"low","description":"Fast"}],"default_reasoning_level":"low"}',
      );
      assert.strictEqual(a.defaultReasoningLevel, "low");
      assert.strictEqual(a.supportedReasoningLevels[0].description, "Fast");
      const b = info(
        '{"id":"gpt-6-astra","supported_reasoning_levels":[],"configurationSchema":{"properties":{"reasoningEffort":{"enum":["high"],"default":"high"}}}}',
      );
      assert.deepStrictEqual(b.supportedReasoningLevels, []);
      assert.strictEqual(b.defaultReasoningLevel, "medium");
    });

    test("honors an explicit empty schema", () => {
      const m = info(
        '{"id":"no","configurationSchema":{"properties":{"reasoningEffort":{"enum":[]}}}}',
      );
      assert.deepStrictEqual(m.supportedReasoningLevels, []);
    });

    test("honors explicit normalized capabilities ahead of the schema", () => {
      const m = info(
        '{"id":"gpt-6-astra","supported_reasoning_levels":[{"effort":"medium"},{"effort":"high"}],"default_reasoning_level":"medium","configurationSchema":{"properties":{"reasoningEffort":{"enum":["max"],"default":"max"}}}}',
      );
      assert.strictEqual(efforts(m), "medium|high");
      assert.strictEqual(m.defaultReasoningLevel, "medium");
    });

    test("accepts a fixed default with an empty explicit list", () => {
      const m = info(
        '{"id":"fixed","supported_reasoning_levels":[],"default_reasoning_level":"none"}',
      );
      assert.strictEqual(m.defaultReasoningLevel, "none");
    });

    for (const metadata of [
      '"configurationSchema":{"properties":{"reasoningEffort":{"enum":"high"}}}',
      '"configurationSchema":{"properties":{"reasoningEffort":{"enum":["high","high"]}}}',
      '"configurationSchema":{"properties":{"reasoningEffort":{"enum":[42]}}}',
      '"configurationSchema":{"properties":{"reasoningEffort":{"enum":["low"],"default":"high"}}}',
      '"supported_reasoning_levels":"high"',
      '"supported_reasoning_levels":[{"effort":" "}]',
      '"supported_reasoning_levels":[{"effort":42}]',
      '"supported_reasoning_levels":[{"effort":"high"},{"effort":"high"}]',
      '"supported_reasoning_levels":[{"effort":"low"}],"default_reasoning_level":"high"',
    ]) {
      test(`rejects invalid effort metadata: ${metadata}`, () => {
        assert.throws(
          () => info(`{"id":"custom",${metadata}}`),
          InvalidModelMetadataError,
        );
      });
    }
  });

  suite("toModelInfo capabilities", () => {
    test("uses upstream context and image capabilities", () => {
      const vision = info(
        '{"id":"vision","maxInputTokens":271790,"capabilities":{"supportsImageToText":true,"supportsToolCalling":true}}',
      );
      assert.strictEqual(vision.contextWindow, 271790);
      assert.deepStrictEqual(vision.inputModalities, ["text", "image"]);
      assert.strictEqual(vision.supportsToolCalling, true);
      const text = info(
        '{"id":"text","maxInputTokens":12078,"capabilities":{"supportsImageToText":false}}',
      );
      assert.strictEqual(text.contextWindow, 12078);
      assert.deepStrictEqual(text.inputModalities, ["text"]);
      const unknown = info('{"id":"unknown"}');
      assert.strictEqual(unknown.contextWindow, null);
      assert.strictEqual(unknown.supportsToolCalling, null);
    });

    test("honors explicit modalities and context over maxInputTokens", () => {
      const m = info(
        '{"id":"custom","context_window":64000,"maxInputTokens":128000,"input_modalities":["text","audio"],"supported_reasoning_levels":[{"effort":"ultra"}],"default_reasoning_level":"ultra"}',
      );
      assert.strictEqual(m.contextWindow, 64000);
      assert.deepStrictEqual(m.inputModalities, ["text", "audio"]);
      assert.strictEqual(m.supportedReasoningLevels[0].effort, "ultra");
    });

    test("reads top-level supportsToolCalling when capabilities omit it", () => {
      assert.strictEqual(
        toModelInfo({ id: "x", supportsToolCalling: false })
          .supportsToolCalling,
        false,
      );
    });

    for (const metadata of [
      '"maxInputTokens":0',
      '"maxInputTokens":-1',
      '"maxInputTokens":1.5',
      '"maxInputTokens":"128000"',
      '"input_modalities":[]',
      '"input_modalities":["video"]',
      '"input_modalities":["text","text"]',
      '"capabilities":{"supportsToolCalling":"true"}',
    ]) {
      test(`rejects invalid context/capability metadata: ${metadata}`, () => {
        assert.throws(
          () => info(`{"id":"custom",${metadata}}`),
          InvalidModelMetadataError,
        );
      });
    }

    for (const id of ["", " ", 42]) {
      test(`rejects invalid model ID: ${JSON.stringify(id)}`, () => {
        assert.throws(
          () => toModelInfo({ id } as unknown as LanguageModelLike),
          InvalidModelMetadataError,
        );
      });
    }

    test("advertises every operation and uses ID when name is blank", () => {
      const m = toModelInfo({
        id: "other",
        name: " ",
        family: "f",
        vendor: "v",
        version: "1",
      });
      assert.deepStrictEqual(m.operations, [...ALL_OPERATIONS]);
      assert.strictEqual(m.displayName, "other");
      assert.strictEqual(m.family, "f");
      assert.strictEqual(
        toModelInfo({ id: "a", name: "First" }).displayName,
        "First",
      );
    });
  });

  suite("dedupeModels", () => {
    test("deduplicates repeated vendor IDs, preserving the first", () => {
      const out = dedupeModels([
        { id: "shared", vendor: "one", name: "First" },
        { id: "shared", vendor: "two", name: "Second" },
        { id: "other" },
      ]);
      assert.deepStrictEqual(
        out.map((m) => m.id),
        ["shared", "other"],
      );
      assert.strictEqual(out[0].name, "First");
    });
  });

  suite("validateModelInfo", () => {
    const valid = () => ({
      id: "gpt-6-astra",
      displayName: "Astra",
      contextWindow: 1000,
      inputModalities: ["text"],
      supportsToolCalling: true,
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "medium", description: "m" }],
      operations: ["openai.responses"],
      extra: "dropped",
    });

    test("accepts and copies a valid model", () => {
      const m = validateModelInfo(valid());
      assert.strictEqual(m.id, "gpt-6-astra");
      assert.ok(!("extra" in m));
      assert.ok(
        validateModelInfo({
          ...valid(),
          contextWindow: null,
          supportsToolCalling: null,
        }),
      );
    });

    const mutations: [string, Record<string, unknown>][] = [
      ["blank id", { id: " " }],
      ["missing displayName", { displayName: undefined }],
      ["bad context", { contextWindow: 0 }],
      ["fractional context", { contextWindow: 1.5 }],
      ["empty modalities", { inputModalities: [] }],
      ["unknown modality", { inputModalities: ["video"] }],
      ["string tool calling", { supportsToolCalling: "true" }],
      [
        "duplicate effort",
        {
          supportedReasoningLevels: [
            { effort: "a", description: "" },
            { effort: "a", description: "" },
          ],
        },
      ],
      ["unsupported default", { defaultReasoningLevel: "high" }],
      ["unknown operation", { operations: ["openai.embeddings"] }],
      ["operations not array", { operations: "openai.responses" }],
      ["family not string", { family: 1 }],
    ];
    for (const [name, patch] of mutations) {
      test(`rejects ${name}`, () => {
        assert.throws(
          () => validateModelInfo({ ...valid(), ...patch }),
          InvalidModelMetadataError,
        );
      });
    }
    for (const v of [null, [], "x"]) {
      test(`rejects non-record ${JSON.stringify(v)}`, () => {
        assert.throws(() => validateModelInfo(v), InvalidModelMetadataError);
      });
    }
  });
});
