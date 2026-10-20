import * as assert from "assert";

import type { LmApi } from "../../../protocol/core/lmRequest";
import { runTurn } from "../../../protocol/core/runTurn";
import {
  formatSettingsLine,
  logRequestSettings,
  settingsFromRequest,
} from "../../../protocol/core/settingsLog";
import type { CoreRequest } from "../../../protocol/core/types";
import { CollectSink } from "../../../protocol/http/sink";

function req(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    protocol: "anthropic",
    model: "local-id",
    echoModel: "claude-opus-5.5",
    system: ["SECRET SYSTEM"],
    turns: [{ role: "user", parts: [{ type: "text", text: "SECRET PROMPT" }] }],
    tools: [],
    toolMode: { kind: "auto" },
    hosted: [],
    stream: true,
    echo: {},
    ...over,
  };
}

function capture() {
  const lines: { level: string; m: string }[] = [];
  const mk = (level: string) => (m: string) => lines.push({ level, m });
  return {
    lines,
    logger: {
      error: mk("error"),
      warn: mk("warn"),
      info: mk("info"),
      debug: mk("debug"),
    },
  };
}

const meta = {
  requestId: "rid-1",
  protocol: "anthropic" as const,
  requestedModel: "claude-opus-5.5",
  resolvedModel: "claude-opus-5.5",
};

suite("protocol/core/settingsLog", () => {
  test("minimal request matches example shape", () => {
    const line = formatSettingsLine(
      meta,
      settingsFromRequest(
        req({
          maxOutputTokens: 64000,
          reasoningEffort: "adaptive",
          tools: Array.from({ length: 24 }, (_, i) => ({
            name: `t${i}`,
            inputSchema: {},
          })),
        }),
      ),
    );
    assert.strictEqual(
      line,
      '[rid-1] anthropic settings model="claude-opus-5.5" resolved="claude-opus-5.5" max_tokens=64000 reasoning=adaptive tools=24 tool_choice=auto stream=true cache_key=no',
    );
  });

  test("no limit logs none; ignored settings are marked", () => {
    const line = formatSettingsLine(
      meta,
      settingsFromRequest(
        req({
          temperature: 0.2,
          topP: 0.9,
          stop: ["a", "b"],
          parallelToolCalls: false,
          stream: false,
          toolMode: { kind: "required", only: ["x"] },
          hosted: [{ kind: "search", wireType: "web_search_20250305" }],
          cacheKey: "k",
        }),
      ),
    );
    assert.ok(line.includes("max_tokens=none"));
    assert.ok(line.includes("temperature=0.2(ignored)"));
    assert.ok(line.includes("top_p=0.9(ignored)"));
    assert.ok(line.includes("stop=2(ignored)"));
    assert.ok(line.includes("tool_choice=required"));
    assert.ok(line.includes("hosted=web_search_20250305"));
    assert.ok(line.includes("parallel_tool_calls=false"));
    assert.ok(line.includes("stream=false"));
    assert.ok(line.includes("cache_key=yes"));
  });

  test("redaction: no prompt, stop text, cache key, args or URLs", () => {
    const { lines, logger } = capture();
    const r = req({
      stop: ["STOPTEXT"],
      cacheKey: "CACHEVALUE",
      reasoningEffort: "http://evil.example/x",
      tools: [{ name: "t", description: "SECRET DESC", inputSchema: { a: 1 } }],
      turns: [
        { role: "user", parts: [{ type: "text", text: "SECRET PROMPT" }] },
        {
          role: "assistant",
          parts: [
            {
              type: "toolCall",
              id: "c",
              name: "t",
              input: { q: "SECRET ARG" },
            },
          ],
        },
      ],
    });
    logRequestSettings(
      logger,
      { ...meta, requestedModel: 'bad model "x" https://u' },
      settingsFromRequest(r),
    );
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, "info");
    const m = lines[0].m;
    for (const bad of ["SECRET", "STOPTEXT", "CACHEVALUE", "://", "evil"]) {
      assert.ok(!m.includes(bad), `leaked ${bad}: ${m}`);
    }
    assert.ok(m.includes('model="redacted"'));
    assert.ok(m.includes("reasoning=redacted"));
  });

  test("runTurn logs exactly one settings line with resolved model", async () => {
    const { lines, logger } = capture();
    class T {
      constructor(public value: string) {}
    }
    const api = {
      LanguageModelChatMessage: {
        User: (content: unknown) => ({ role: "user", content }),
        Assistant: (content: unknown) => ({ role: "assistant", content }),
      },
      LanguageModelTextPart: T,
      LanguageModelToolCallPart: class {},
      LanguageModelToolResultPart: class {},
      LanguageModelDataPart: { image: () => ({}) },
      LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    } as unknown as LmApi;
    const model = {
      id: "copilot-resolved",
      maxInputTokens: 1000,
      sendRequest: () =>
        Promise.resolve({
          stream: (async function* () {
            yield new T("ok");
          })(),
        }),
      countTokens: () => Promise.resolve(1),
    };
    await runTurn({
      api,
      model,
      req: req(),
      scope: {
        requestId: "rid-9",
        token: { isCancellationRequested: false },
        reason: undefined,
        markFirstChunk: () => undefined,
        timeoutError: () => undefined,
      },
      encoder: { onEvent: () => undefined, finish: () => undefined },
      sink: new CollectSink<unknown>(),
      logger,
    });
    const s = lines.filter((l) => l.m.includes(" settings "));
    assert.strictEqual(s.length, 1);
    assert.ok(s[0].m.startsWith("[rid-9] anthropic settings"));
    assert.ok(s[0].m.includes('resolved="copilot-resolved"'));
  });
});
