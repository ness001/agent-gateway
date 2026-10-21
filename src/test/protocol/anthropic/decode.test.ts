import * as assert from "assert";

import {
  MISSING_MODEL_MESSAGE,
  decodeMessagesRequest,
  reasoningEffortFor,
} from "../../../protocol/anthropic/decode";
import { GatewayError } from "../../../protocol/core/errors";
import { repairPairing } from "../../../protocol/core/pairing";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]).toString("base64");

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "ping" }],
    ...over,
  };
}

function throwsKind(fn: () => unknown, kind: string, re?: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GatewayError, String(e));
    assert.strictEqual(e.kind, kind);
    if (re) {
      assert.match(e.message, re);
    }
    return true;
  });
}

suite("protocol/anthropic decode", () => {
  test("missing model returns the fixed message", () => {
    throwsKind(
      () => decodeMessagesRequest({ messages: [] }),
      "invalid_request",
      new RegExp(`^${MISSING_MODEL_MESSAGE.replace(/\./g, "\\.")}$`),
    );
    throwsKind(
      () => decodeMessagesRequest(base({ model: " " })),
      "invalid_request",
    );
  });

  test("malformed bodies are invalid_request with a path", () => {
    throwsKind(() => decodeMessagesRequest([]), "invalid_request");
    throwsKind(
      () => decodeMessagesRequest(base({ messages: undefined })),
      "invalid_request",
      /messages/,
    );
    throwsKind(
      () => decodeMessagesRequest(base({ messages: "x" })),
      "invalid_request",
      /messages/,
    );
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({ messages: [{ role: "tool", content: "x" }] }),
        ),
      "invalid_request",
      /messages\[0\]\.role/,
    );
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({ messages: [{ role: "user", content: [{ type: "text" }] }] }),
        ),
      "invalid_request",
      /messages\[0\]\.content\[0\]\.text/,
    );
    throwsKind(
      () => decodeMessagesRequest(base({ max_tokens: 0 })),
      "invalid_request",
      /max_tokens/,
    );
    throwsKind(
      () => decodeMessagesRequest(base({ temperature: 3 })),
      "invalid_request",
      /temperature/,
    );
    throwsKind(
      () => decodeMessagesRequest(base({ stream: "yes" })),
      "invalid_request",
      /stream/,
    );
  });

  test("system string and blocks become system text", () => {
    assert.deepStrictEqual(
      decodeMessagesRequest(base({ system: "be brief" })).system,
      ["be brief"],
    );
    assert.deepStrictEqual(
      decodeMessagesRequest(
        base({
          system: [
            { type: "text", text: "a", cache_control: { type: "ephemeral" } },
            { type: "text", text: "b" },
          ],
        }),
      ).system,
      ["a", "b"],
    );
    throwsKind(
      () => decodeMessagesRequest(base({ system: [{ type: "image" }] })),
      "invalid_request",
    );
  });

  test("sampling, stop, metadata and max_tokens forwarded", () => {
    const r = decodeMessagesRequest(
      base({
        max_tokens: 64000,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["END"],
        metadata: { user_id: "u" },
        stream: true,
      }),
    );
    assert.strictEqual(r.maxOutputTokens, 64000);
    assert.strictEqual(r.temperature, 0.5);
    assert.strictEqual(r.topP, 0.9);
    assert.deepStrictEqual(r.stop, ["END"]);
    assert.strictEqual(r.stream, true);
    assert.strictEqual(r.echoModel, "claude-sonnet-5.5");
    assert.strictEqual(r.protocol, "anthropic");
  });

  test("no max_tokens sends no limit", () => {
    const r = decodeMessagesRequest(base({ max_tokens: undefined }));
    assert.strictEqual(r.maxOutputTokens, undefined);
    assert.strictEqual(r.stream, false);
  });

  test("tool_choice auto/any/tool/none and disable_parallel_tool_use", () => {
    const tools = [
      { name: "a", description: "A", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" } },
    ];
    const d = (tc: unknown) =>
      decodeMessagesRequest(base({ tools, tool_choice: tc }));
    assert.deepStrictEqual(d(undefined).toolMode, { kind: "auto" });
    assert.deepStrictEqual(d({ type: "auto" }).toolMode, { kind: "auto" });
    assert.deepStrictEqual(d({ type: "any" }).toolMode, { kind: "required" });
    assert.deepStrictEqual(d({ type: "none" }).toolMode, { kind: "none" });
    assert.deepStrictEqual(d({ type: "tool", name: "b" }).toolMode, {
      kind: "required",
      only: ["b"],
    });
    assert.strictEqual(
      d({ type: "auto", disable_parallel_tool_use: true }).parallelToolCalls,
      false,
    );
    assert.strictEqual(d({ type: "auto" }).parallelToolCalls, undefined);
    throwsKind(
      () => d({ type: "tool", name: "zzz" }),
      "invalid_request",
      /tool_choice\.name/,
    );
    throwsKind(
      () => d({ type: "bogus" }),
      "invalid_request",
      /tool_choice\.type/,
    );
    const r = d(undefined);
    assert.deepStrictEqual(r.tools, [
      { name: "a", description: "A", inputSchema: { type: "object" } },
      { name: "b", inputSchema: { type: "object" } },
    ]);
  });

  test("custom tool type accepted; missing input_schema rejected", () => {
    const r = decodeMessagesRequest(
      base({
        tools: [
          { type: "custom", name: "x", input_schema: { type: "object" } },
        ],
      }),
    );
    assert.strictEqual(r.tools[0].name, "x");
    throwsKind(
      () => decodeMessagesRequest(base({ tools: [{ name: "x" }] })),
      "invalid_request",
      /input_schema/,
    );
  });

  test("optional web_search tool is dropped without a provider; other server tools unsupported", () => {
    const r = decodeMessagesRequest(
      base({
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    );
    assert.deepStrictEqual(r.hosted, []);
    assert.deepStrictEqual(r.tools, []);
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({ tools: [{ type: "bash_20250124", name: "bash" }] }),
        ),
      "unsupported",
    );
  });

  test("system-role entries in messages join the system prompt", () => {
    const r = decodeMessagesRequest(
      base({
        system: "top",
        messages: [
          { role: "user", content: "ping" },
          { role: "system", content: [{ type: "text", text: "env" }] },
          { role: "system", content: "more" },
        ],
      }),
    );
    assert.deepStrictEqual(r.system, ["top", "env", "more"]);
    assert.deepStrictEqual(
      r.turns.map((t) => t.role),
      ["user"],
    );
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({ messages: [{ role: "tool", content: "x" }] }),
        ),
      "invalid_request",
    );
  });

  test("tool_use and tool_result (string, blocks, is_error) are forwarded", () => {
    const r = decodeMessagesRequest(
      base({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "toolu_1", name: "a", input: { q: 1 } },
              { type: "tool_use", id: "toolu_2", name: "b", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                is_error: true,
                content: [
                  { type: "text", text: "boom" },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: PNG,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.deepStrictEqual(r.turns[1].parts[1], {
      type: "toolCall",
      id: "toolu_1",
      name: "a",
      input: { q: 1 },
    });
    const t0 = r.turns[2].parts[0];
    assert.deepStrictEqual(t0, {
      type: "toolResult",
      callId: "toolu_1",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const t1 = r.turns[2].parts[1];
    assert.ok(t1.type === "toolResult");
    assert.strictEqual(t1.isError, true);
    assert.strictEqual(t1.content.length, 2);
    assert.strictEqual(t1.content[1].type, "image");
  });

  test("tool_use in user turn and tool_result in assistant turn are rejected", () => {
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({
            messages: [
              {
                role: "user",
                content: [{ type: "tool_use", id: "t", name: "a", input: {} }],
              },
            ],
          }),
        ),
      "invalid_request",
    );
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool_result", tool_use_id: "t" }],
              },
            ],
          }),
        ),
      "invalid_request",
    );
  });

  test("base64 image blocks are decoded and sniffed", () => {
    const r = decodeMessagesRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: PNG },
              },
              { type: "text", text: "what?" },
            ],
          },
        ],
      }),
    );
    const p = r.turns[0].parts[0];
    assert.ok(p.type === "image");
    assert.strictEqual(p.mime, "image/png");
    assert.strictEqual(p.data.length, 12);
  });

  test("url image sources: data URL accepted, remote URL as text, bad base64 400", () => {
    const ok = decodeMessagesRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: `data:image/png;base64,${PNG}` },
              },
            ],
          },
        ],
      }),
    );
    assert.strictEqual(ok.turns[0].parts[0].type, "image");
    const remote = decodeMessagesRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/a.png" },
              },
            ],
          },
        ],
      }),
    );
    assert.deepStrictEqual(remote.turns[0].parts[0], {
      type: "text",
      text: '{"type":"image","url":"https://example.com/a.png"}',
      imageUrl: "https://example.com/a.png",
    });
    throwsKind(
      () =>
        decodeMessagesRequest(
          base({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "!!!",
                    },
                  },
                ],
              },
            ],
          }),
        ),
      "invalid_request",
      /base64/,
    );
  });

  test("document blocks become text; base64 data is omitted", () => {
    const r = decodeMessagesRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "text", data: "x" } },
              {
                type: "document",
                title: "T",
                source: { type: "url", url: "https://e.com/a.pdf" },
              },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "AAAAAAAA",
                },
              },
            ],
          },
        ],
      }),
    );
    assert.deepStrictEqual(r.turns[0].parts, [
      { type: "text", text: "x" },
      {
        type: "text",
        text: '{"type":"document","source_type":"url","url":"https://e.com/a.pdf","title":"T"}',
      },
      {
        type: "text",
        text: '{"type":"document","source_type":"base64","media_type":"application/pdf","data":"<omitted 6 bytes>"}',
      },
    ]);
  });

  test("thinking and redacted_thinking replay is accepted", () => {
    const r = decodeMessagesRequest(
      base({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig" },
              { type: "redacted_thinking", data: "xxx" },
              { type: "text", text: "a" },
            ],
          },
          { role: "user", content: "again" },
        ],
      }),
    );
    assert.deepStrictEqual(r.turns[1].parts, [
      { type: "thinking", text: "hmm", signature: "sig" },
      { type: "text", text: "a" },
    ]);
  });

  test("thinking config maps to reasoning effort", () => {
    assert.strictEqual(reasoningEffortFor({}), undefined);
    assert.strictEqual(
      reasoningEffortFor({ thinking: { type: "disabled" } }),
      undefined,
    );
    assert.strictEqual(
      reasoningEffortFor({ thinking: { type: "adaptive" } }),
      undefined,
    );
    assert.strictEqual(
      reasoningEffortFor({
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
      "low",
    );
    assert.strictEqual(
      reasoningEffortFor({
        thinking: { type: "enabled", budget_tokens: 8000 },
      }),
      "medium",
    );
    assert.strictEqual(
      reasoningEffortFor({
        thinking: { type: "enabled", budget_tokens: 32000 },
      }),
      "high",
    );
    assert.strictEqual(
      reasoningEffortFor({
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      }),
      "xhigh",
    );
    throwsKind(
      () => reasoningEffortFor({ thinking: { type: "enabled" } }),
      "invalid_request",
      /budget_tokens/,
    );
    throwsKind(
      () => reasoningEffortFor({ thinking: { type: "on" } }),
      "invalid_request",
      /thinking\.type/,
    );
    const r = decodeMessagesRequest(
      base({ thinking: { type: "enabled", budget_tokens: 2048 } }),
    );
    assert.strictEqual(r.reasoningEffort, "low");
  });

  test("requested model id is echoed unchanged", () => {
    const r = decodeMessagesRequest(base({ model: "gpt-6-astra" }));
    assert.strictEqual(r.model, "gpt-6-astra");
    assert.strictEqual(r.echoModel, "gpt-6-astra");
  });

  test("count_tokens bodies need no max_tokens and are never streamed", () => {
    const r = decodeMessagesRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stream: true,
        max_tokens: 5,
      },
      { countTokens: true },
    );
    assert.strictEqual(r.stream, false);
    assert.strictEqual(r.maxOutputTokens, undefined);
  });

  test("captured Claude Code request shape decodes", () => {
    const r = decodeMessagesRequest({
      model: "claude-opus-5.5",
      max_tokens: 64000,
      stream: true,
      thinking: { type: "adaptive" },
      metadata: { user_id: "user_abc" },
      system: [
        {
          type: "text",
          text: "You are Claude Code.",
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "Env info" },
      ],
      tools: Array.from({ length: 24 }, (_, i) => ({
        name: `Tool${i}`,
        description: "d",
        input_schema: {
          type: "object",
          properties: {},
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      })),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>x</system-reminder>" },
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    assert.strictEqual(r.tools.length, 24);
    assert.strictEqual(r.maxOutputTokens, 64000);
    assert.strictEqual(r.reasoningEffort, undefined);
    assert.strictEqual(r.echo.thinking, "adaptive");
    assert.strictEqual(r.system.length, 2);
  });
});

suite("anthropic parallel tool history", () => {
  test("fragmented parallel calls and completion-order results form one pair of turns", () => {
    const messages = [
      ...["a", "b", "c", "d", "e"].map((id) => ({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Read", input: {} }],
      })),
      ...["d", "e", "a", "b", "c"].map((id) => ({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: `result-${id}` },
        ],
      })),
    ];
    const original = JSON.stringify(messages);
    const decoded = decodeMessagesRequest(base({ messages }));
    assert.strictEqual(decoded.turns.length, 2);
    const repaired = repairPairing(decoded.turns);
    assert.deepStrictEqual(repaired.repairs, []);
    assert.deepStrictEqual(
      repaired.turns[1].parts.map((p) =>
        p.type === "toolResult" ? p.callId : "",
      ),
      ["a", "b", "c", "d", "e"],
    );
    assert.strictEqual(JSON.stringify(messages), original);
  });
});
