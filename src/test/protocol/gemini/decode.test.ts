import * as assert from "assert";

import { GatewayError } from "../../../protocol/core/errors";
import { decodeGeminiRequest } from "../../../protocol/gemini/decode";
import { geminiSchemaToJsonSchema } from "../../../protocol/gemini/schema";

const ctx = { model: "m", echoModel: "gemini-x", stream: false };
const user = (text: string) => ({ role: "user", parts: [{ text }] });
const decode = (body: Record<string, unknown>) =>
  decodeGeminiRequest({ contents: [user("hi")], ...body }, ctx);

function throwsKind(fn: () => unknown, kind: string, re?: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GatewayError);
    assert.strictEqual(e.kind, kind);
    if (re) {
      assert.match(e.message, re);
    }
    return true;
  });
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]).toString("base64");

suite("protocol/gemini/schema", () => {
  test("lower-cases uppercase types recursively", () => {
    const out = geminiSchemaToJsonSchema({
      type: "OBJECT",
      properties: {
        a: { type: "STRING", format: "enum", enum: ["x", "y"] },
        b: { type: "ARRAY", items: { type: "INTEGER" } },
      },
      required: ["a"],
      propertyOrdering: ["a", "b"],
    });
    assert.deepStrictEqual(out, {
      type: "object",
      properties: {
        a: { type: "string", format: "enum", enum: ["x", "y"] },
        b: { type: "array", items: { type: "integer" } },
      },
      required: ["a"],
    });
  });

  test("nullable becomes a null type alternative", () => {
    assert.deepStrictEqual(
      geminiSchemaToJsonSchema({ type: "NUMBER", nullable: true }),
      { type: ["number", "null"] },
    );
    assert.deepStrictEqual(
      geminiSchemaToJsonSchema({ type: "STRING", nullable: true, enum: ["a"] }),
      { type: ["string", "null"], enum: ["a", null] },
    );
  });

  test("anyOf converted; unknown keywords dropped", () => {
    const out = geminiSchemaToJsonSchema({
      anyOf: [{ type: "STRING" }, { type: "BOOLEAN" }],
      $weird: 1,
      description: "d",
    });
    assert.deepStrictEqual(out, {
      anyOf: [{ type: "string" }, { type: "boolean" }],
      description: "d",
    });
  });

  test("TYPE_UNSPECIFIED omits type; bad type is 400", () => {
    assert.deepStrictEqual(
      geminiSchemaToJsonSchema({ type: "TYPE_UNSPECIFIED" }),
      {},
    );
    throwsKind(
      () => geminiSchemaToJsonSchema({ type: "BLOB" }),
      "invalid_request",
      /unknown type/,
    );
    throwsKind(() => geminiSchemaToJsonSchema("x"), "invalid_request");
  });
});

suite("protocol/gemini/decode", () => {
  test("functionDeclarations with parameters and parametersJsonSchema", () => {
    const r = decode({
      tools: [
        {
          functionDeclarations: [
            {
              name: "a",
              description: "A",
              parameters: {
                type: "OBJECT",
                properties: { q: { type: "STRING" } },
              },
            },
            {
              name: "b",
              parametersJsonSchema: {
                type: "object",
                additionalProperties: false,
              },
            },
            { name: "c" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(r.tools, [
      {
        name: "a",
        description: "A",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "b",
        inputSchema: { type: "object", additionalProperties: false },
      },
      { name: "c", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  test("duplicate function names are 400", () => {
    throwsKind(
      () =>
        decode({
          tools: [{ functionDeclarations: [{ name: "a" }, { name: "a" }] }],
        }),
      "invalid_request",
      /duplicate/,
    );
  });

  test("search-only tools without a provider give tool_unavailable (FAILED_PRECONDITION)", () => {
    for (const key of [
      "googleSearch",
      "googleSearchRetrieval",
      "google_search",
    ]) {
      throwsKind(() => decode({ tools: [{ [key]: {} }] }), "tool_unavailable");
    }
  });

  test("functionCall and functionResponse ids inferred by name and order", () => {
    const r = decodeGeminiRequest(
      {
        contents: [
          user("go"),
          {
            role: "model",
            parts: [
              { functionCall: { name: "f", args: { x: 1 } } },
              { functionCall: { name: "f", args: { x: 2 } } },
            ],
          },
          {
            role: "function",
            parts: [
              { functionResponse: { name: "f", response: { output: "1" } } },
              { functionResponse: { name: "f", response: { output: "2" } } },
            ],
          },
        ],
      },
      ctx,
    );
    const calls = r.turns[1].parts;
    const results = r.turns[2].parts;
    assert.strictEqual(r.turns[2].role, "user");
    assert.strictEqual(calls[0].type, "toolCall");
    assert.ok(calls[0].type === "toolCall" && calls[0].id);
    assert.ok(calls[1].type === "toolCall" && calls[0].type === "toolCall");
    assert.ok(
      results[0].type === "toolResult" && results[1].type === "toolResult",
    );
    if (
      calls[0].type === "toolCall" &&
      calls[1].type === "toolCall" &&
      results[0].type === "toolResult" &&
      results[1].type === "toolResult"
    ) {
      assert.notStrictEqual(calls[0].id, calls[1].id);
      assert.strictEqual(results[0].callId, calls[0].id);
      assert.strictEqual(results[1].callId, calls[1].id);
      assert.deepStrictEqual(results[0].content, [
        { type: "text", text: '{"output":"1"}' },
      ]);
      assert.deepStrictEqual(calls[1].input, { x: 2 });
    }
  });

  test("explicit ids are kept; error responses flagged", () => {
    const r = decodeGeminiRequest(
      {
        contents: [
          user("go"),
          { role: "model", parts: [{ functionCall: { id: "c1", name: "f" } }] },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "c1",
                  name: "f",
                  response: { error: "boom" },
                },
              },
            ],
          },
        ],
      },
      ctx,
    );
    const res = r.turns[2].parts[0];
    assert.ok(res.type === "toolResult");
    if (res.type === "toolResult") {
      assert.strictEqual(res.callId, "c1");
      assert.strictEqual(res.isError, true);
    }
  });

  test("tool modes AUTO/VALIDATED/NONE/ANY", () => {
    const tools = [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }];
    const mode = (fcc: unknown) =>
      decode({ tools, toolConfig: { functionCallingConfig: fcc } }).toolMode;
    assert.deepStrictEqual(decode({}).toolMode, { kind: "auto" });
    assert.deepStrictEqual(mode({ mode: "AUTO" }), { kind: "auto" });
    assert.deepStrictEqual(mode({ mode: "VALIDATED" }), { kind: "auto" });
    assert.deepStrictEqual(mode({ mode: "NONE" }), { kind: "none" });
    assert.deepStrictEqual(mode({ mode: "ANY" }), { kind: "required" });
    assert.deepStrictEqual(mode({ mode: "ANY", allowedFunctionNames: ["b"] }), {
      kind: "required",
      only: ["b"],
    });
  });

  test("unknown mode or function name is 400", () => {
    const tools = [{ functionDeclarations: [{ name: "a" }] }];
    throwsKind(
      () =>
        decode({
          tools,
          toolConfig: { functionCallingConfig: { mode: "SOMETIMES" } },
        }),
      "invalid_request",
      /unsupported mode/,
    );
    throwsKind(
      () =>
        decode({
          tools,
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["z"] },
          },
        }),
      "invalid_request",
      /unknown function/,
    );
  });

  test("inlineData images decoded with sniffed mime", () => {
    const r = decodeGeminiRequest(
      {
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/jpeg", data: PNG } }],
          },
        ],
      },
      ctx,
    );
    const p = r.turns[0].parts[0];
    assert.ok(p.type === "image");
    if (p.type === "image") {
      assert.strictEqual(p.mime, "image/png");
      assert.strictEqual(p.data.length, 12);
    }
  });

  test("bad inlineData is 400", () => {
    throwsKind(
      () =>
        decodeGeminiRequest(
          { contents: [{ parts: [{ inlineData: {} }] }] },
          ctx,
        ),
      "invalid_request",
    );
  });

  test("systemInstruction as object or string", () => {
    assert.deepStrictEqual(
      decode({ systemInstruction: { parts: [{ text: "a" }, { text: "b" }] } })
        .system,
      ["a\nb"],
    );
    assert.deepStrictEqual(decode({ systemInstruction: "s" }).system, ["s"]);
    assert.deepStrictEqual(decode({}).system, []);
  });

  test("fileData parts become text", () => {
    const r = decodeGeminiRequest(
      {
        contents: [
          {
            parts: [{ fileData: { fileUri: "gs://x", mimeType: "image/png" } }],
          },
        ],
      },
      ctx,
    );
    assert.deepStrictEqual(r.turns[0].parts[0], {
      type: "text",
      text: '{"type":"fileData","fileUri":"gs://x","mimeType":"image/png"}',
    });
  });

  test("thought parts with signature replayed on model turns", () => {
    const r = decodeGeminiRequest(
      {
        contents: [
          user("q"),
          {
            role: "model",
            parts: [
              { text: "hmm", thought: true, thoughtSignature: "sig" },
              { text: "answer" },
              { thoughtSignature: "bare" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "x", thought: true }, { text: "next" }],
          },
        ],
      },
      ctx,
    );
    assert.deepStrictEqual(r.turns[1], {
      role: "assistant",
      parts: [
        { type: "thinking", text: "hmm", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    });
    assert.deepStrictEqual(r.turns[2].parts, [{ type: "text", text: "next" }]);
  });

  test("generationConfig fields mapped", () => {
    const r = decode({
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 1,
        topP: 0.95,
        topK: 40,
        stopSequences: ["END"],
        candidateCount: 2,
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT" },
        thinkingConfig: {
          thinkingBudget: 512,
          includeThoughts: true,
          thinkingLevel: "HIGH",
        },
      },
    });
    assert.strictEqual(r.maxOutputTokens, 100);
    assert.strictEqual(r.temperature, 1);
    assert.strictEqual(r.topP, 0.95);
    assert.deepStrictEqual(r.stop, ["END"]);
    assert.strictEqual(r.reasoningEffort, "high");
    assert.deepStrictEqual(r.echo, {
      topK: 40,
      candidateCount: 2,
      responseMimeType: "application/json",
      responseSchema: true,
      thinkingBudget: 512,
      includeThoughts: true,
    });
  });

  test("no limit sent means none forwarded", () => {
    const r = decode({ generationConfig: { temperature: 1 } });
    assert.strictEqual(r.maxOutputTokens, undefined);
    assert.strictEqual("maxOutputTokens" in r, false);
    assert.strictEqual(r.stream, false);
    assert.strictEqual(r.protocol, "gemini");
    assert.deepStrictEqual(r.hosted, []);
  });

  test("invalid generationConfig values are 400", () => {
    throwsKind(
      () => decode({ generationConfig: { maxOutputTokens: "x" } }),
      "invalid_request",
    );
    throwsKind(
      () => decode({ generationConfig: { maxOutputTokens: 0 } }),
      "invalid_request",
    );
    throwsKind(
      () => decode({ generationConfig: { stopSequences: [1] } }),
      "invalid_request",
    );
    throwsKind(
      () => decode({ generationConfig: { candidateCount: 0 } }),
      "invalid_request",
    );
  });

  test("contents required; unknown role is 400", () => {
    throwsKind(
      () => decodeGeminiRequest({}, ctx),
      "invalid_request",
      /contents/,
    );
    throwsKind(
      () =>
        decodeGeminiRequest({ contents: [{ role: "system", parts: [] }] }, ctx),
      "invalid_request",
      /role/,
    );
  });
});
