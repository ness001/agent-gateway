import * as assert from "assert";

import { buildRegistry } from "../../gateway/catalog";
import { toModelInfo } from "../../gateway/discovery";
import { resolveModelAlias } from "../../gateway/match";
import {
  mappingCandidates,
  mappingPrompt,
  mappingSources,
  parseMappings,
} from "../../gateway/modelMapping";

const models = buildRegistry(
  [
    toModelInfo({ id: "fast", supports_tool_calling: true }),
    toModelInfo({ id: "balanced" }),
  ],
  [{ name: "remote", models: [toModelInfo({ id: "remote-model" })] }],
);
const sources = ["claude-haiku-5.5", "claude-sonnet-5"];
const mappings = [
  {
    source: sources[0],
    target: "fast",
    reason: "Lightweight work; performance not measured.",
  },
  {
    source: sources[1],
    target: "balanced",
    reason: "Balanced coding; uncertain latency.",
  },
];
suite("gateway AI model mapping", () => {
  test("sources preserve exact spelling and remove duplicates", () => {
    assert.deepStrictEqual(
      mappingSources("claude-haiku-5.5, claude-sonnet-5 claude-haiku-5.5"),
      sources,
    );
    for (const input of [
      "",
      "https://example.com",
      "__proto__",
      Array(31).fill("a").join(","),
    ]) {
      assert.throws(() => mappingSources(input));
    }
  });
  test("candidates exclude aliases, remotes, incompatible operations and unsupported tools", () => {
    assert.deepStrictEqual(
      mappingCandidates([
        ...models,
        { ...models[0], id: "no-tools", supportsToolCalling: false },
        { ...models[0], id: "no-api", operations: [] },
      ]).map((m) => m.id),
      ["fast", "balanced"],
    );
  });
  test("prompt includes only whitelisted catalog metadata", () => {
    const prompt = mappingPrompt(sources, [
      { ...models[0], unexpectedSecret: "PRIVATE" } as (typeof models)[0],
    ]);
    assert.ok(prompt.includes("claude-haiku-5.5"));
    assert.ok(!prompt.includes("PRIVATE"));
    assert.ok(!prompt.includes("remote-model"));
  });
  test("parses JSON and fenced JSON and routes requested agent names", () => {
    for (const text of [
      JSON.stringify({ mappings }),
      "```json\n" + JSON.stringify({ mappings }) + "\n```",
    ]) {
      const result = parseMappings(text, sources, models);
      const userAliases = Object.fromEntries(
        result.map((m) => [m.source, m.target]),
      );
      assert.strictEqual(
        resolveModelAlias(models, sources[0], {
          userAliases,
          operation: "anthropic.messages",
        })?.id,
        "fast",
      );
      assert.strictEqual(
        resolveModelAlias(models, sources[1], {
          userAliases,
          operation: "anthropic.messages",
        })?.id,
        "balanced",
      );
    }
  });
  test("rejects invented targets, sources, duplicate entries, missing entries and invalid output", () => {
    for (const text of [
      "oops",
      "x".repeat(32001),
      "null",
      JSON.stringify({ mappings: [] }),
      ...["invented", "remote--remote-model", "gateway-claude-fast"].map(
        (target) =>
          JSON.stringify({
            mappings: [{ ...mappings[0], target }, mappings[1]],
          }),
      ),
      JSON.stringify({ mappings: [mappings[0], mappings[0]] }),
      JSON.stringify({
        mappings: [{ ...mappings[0], source: "invented" }, mappings[1]],
      }),
      JSON.stringify({
        mappings: [{ ...mappings[0], reason: "" }, mappings[1]],
      }),
    ]) {
      assert.throws(() => parseMappings(text, sources, models));
    }
  });
});
