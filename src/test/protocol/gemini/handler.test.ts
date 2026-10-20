import * as assert from "assert";

import type { LmApi } from "../../../protocol/core/lmRequest";
import type { LmChatLike, ProtocolDeps } from "../../../protocol/core/types";
import { type GeminiEnv, handleGemini } from "../../../protocol/gemini";

class TextPart {
  constructor(public value: string) {}
}
class ToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
class ToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
class ThinkingPart {
  constructor(
    public value: string,
    public metadata?: Record<string, unknown>,
  ) {}
}
const api: LmApi = {
  LanguageModelChatMessage: {
    User: (content) => ({ role: "user", content }),
    Assistant: (content) => ({ role: "assistant", content }),
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: { image: (data, mime) => ({ data, mimeType: mime }) },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};
const usagePart = {
  mimeType: "usage",
  data: new TextEncoder().encode(
    JSON.stringify({ prompt_tokens: 12, completion_tokens: 7 }),
  ),
};

type Tok = { isCancellationRequested: boolean };
interface Fake extends LmChatLike {
  sent?: { messages: unknown[]; options: unknown };
}
function fake(
  stream: (t: Tok) => AsyncIterable<unknown>,
  opts: { throwOnSend?: unknown; count?: number } = {},
): Fake {
  const m: Fake = {
    id: "copilot-m",
    maxInputTokens: 1000,
    sendRequest(messages, options, token) {
      m.sent = { messages, options };
      if (opts.throwOnSend) {
        return Promise.reject(opts.throwOnSend);
      }
      return Promise.resolve({ stream: stream(token as Tok) });
    },
    countTokens: () => Promise.resolve(opts.count ?? 5),
  };
  return m;
}
async function* parts(list: unknown[]): AsyncIterable<unknown> {
  for (const p of list) {
    yield p;
  }
}

function setup(model: Fake | undefined, deadlineMs?: number) {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = (m: string) => logs.push(m);
  const deps: ProtocolDeps = {
    getLocalModel: (id) => (id === "gemini-x" ? model : undefined),
    maxSearchesPerRequest: 0,
    logger: { info: log, warn: log, error: log, debug: () => undefined },
    noteRequestError: (k) => errs.push(k),
  };
  const env: GeminiEnv = {
    api,
    deadlineMs,
    createSource: () => {
      const token = { isCancellationRequested: false };
      return {
        token,
        cancel: () => (token.isCancellationRequested = true),
        dispose: () => undefined,
      };
    },
  };
  const call = (
    op: string,
    body: unknown,
    init: { query?: string; signal?: AbortSignal; raw?: string } = {},
  ) =>
    handleGemini(
      new Request(
        `http://127.0.0.1:24445/v1beta/models/gemini-x:${op}${init.query ?? ""}`,
        {
          method: "POST",
          body: init.raw ?? JSON.stringify(body),
          signal: init.signal,
        },
      ),
      deps,
      "rid-g",
      env,
    );
  return { call, logs, errs };
}

const userHi = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

function sseChunks(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as unknown);
}

suite("protocol/gemini handler", () => {
  test("generateContent returns text candidate with usage and modelVersion", async () => {
    const { call } = setup(
      fake(() => parts([new TextPart("Hel"), new TextPart("lo"), usagePart])),
    );
    const r = await call("generateContent", userHi);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("x-request-id"), "rid-g");
    const j = (await r.json()) as {
      candidates: {
        content: { parts: { text: string }[] };
        finishReason: string;
      }[];
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
      modelVersion: string;
    };
    assert.deepStrictEqual(j.candidates[0].content.parts, [{ text: "Hello" }]);
    assert.strictEqual(j.candidates[0].finishReason, "STOP");
    assert.strictEqual(j.usageMetadata.promptTokenCount, 12);
    assert.strictEqual(j.usageMetadata.candidatesTokenCount, 7);
    assert.strictEqual(j.modelVersion, "gemini-x");
  });

  test("function call then functionResponse continuation pairs ids", async () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            parameters: {
              type: "OBJECT",
              properties: { city: { type: "STRING" } },
            },
          },
        ],
      },
    ];
    const s1 = setup(
      fake(() =>
        parts([
          new ToolCallPart("call_1", "get_weather", { city: "P" }),
          usagePart,
        ]),
      ),
    );
    const r1 = await s1.call("generateContent", { ...userHi, tools });
    const j1 = (await r1.json()) as {
      candidates: { content: { parts: Record<string, unknown>[] } }[];
    };
    assert.deepStrictEqual(j1.candidates[0].content.parts[0], {
      functionCall: { id: "call_1", name: "get_weather", args: { city: "P" } },
    });
    const m2 = fake(() => parts([new TextPart("sunny"), usagePart]));
    const r2 = await setup(m2).call("generateContent", {
      tools,
      contents: [
        userHi.contents[0],
        {
          role: "model",
          parts: [
            { functionCall: { name: "get_weather", args: { city: "P" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "get_weather", response: { t: 20 } } },
          ],
        },
      ],
    });
    assert.strictEqual(r2.status, 200);
    const all = (m2.sent?.messages as { content: unknown[] }[]).flatMap(
      (m) => m.content,
    );
    const c = all.find((p) => p instanceof ToolCallPart) as ToolCallPart;
    const res = all.find((p) => p instanceof ToolResultPart) as ToolResultPart;
    assert.ok(c && res);
    assert.ok(c.callId.length > 0);
    assert.strictEqual(c.callId, res.callId);
  });

  test("streamGenerateContent alt=sse frames data-only with final chunk", async () => {
    const { call } = setup(
      fake(() => parts([new TextPart("a"), new TextPart("b"), usagePart])),
    );
    const r = await call("streamGenerateContent", userHi, {
      query: "?alt=sse",
    });
    assert.strictEqual(r.headers.get("content-type"), "text/event-stream");
    const chunks = sseChunks(await r.text()) as {
      candidates: { finishReason?: string }[];
      usageMetadata?: unknown;
    }[];
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[2].candidates[0].finishReason, "STOP");
    assert.ok(chunks[2].usageMetadata);
  });

  test("streamGenerateContent without alt is one valid JSON array", async () => {
    const { call } = setup(fake(() => parts([new TextPart("a"), usagePart])));
    const r = await call("streamGenerateContent", userHi);
    assert.strictEqual(r.headers.get("content-type"), "application/json");
    const arr = JSON.parse(await r.text()) as unknown[];
    assert.ok(Array.isArray(arr));
    assert.strictEqual(arr.length, 2);
  });

  test("thoughts are emitted when includeThoughts is set", async () => {
    const { call } = setup(
      fake(() =>
        parts([
          new ThinkingPart("hmm", { signature: "sig1" }),
          new TextPart("ok"),
          usagePart,
        ]),
      ),
    );
    const r = await call("generateContent", {
      ...userHi,
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    });
    const j = (await r.json()) as {
      candidates: { content: { parts: Record<string, unknown>[] } }[];
    };
    assert.deepStrictEqual(j.candidates[0].content.parts[0], {
      text: "hmm",
      thought: true,
      thoughtSignature: "sig1",
    });
  });

  test("countTokens returns totalTokens", async () => {
    const r = await setup(fake(() => parts([]), { count: 4 })).call(
      "countTokens",
      userHi,
    );
    assert.strictEqual(r.status, 200);
    const j = (await r.json()) as { totalTokens: number };
    assert.ok(j.totalTokens > 0 && j.totalTokens % 4 === 0);
  });

  test("countTokens failure uses the Google error envelope", async () => {
    const m = fake(() => parts([]));
    m.countTokens = () => Promise.reject(new Error("boom"));
    const r = await setup(m).call("countTokens", userHi);
    const j = (await r.json()) as {
      error: { status: string };
      request_id: string;
    };
    assert.ok(r.status >= 400);
    assert.ok(j.error.status);
    assert.strictEqual(j.request_id, "rid-g");
  });

  test("unresolved model returns 404 NOT_FOUND", async () => {
    const r = await setup(undefined).call("generateContent", userHi);
    assert.strictEqual(r.status, 404);
    const j = (await r.json()) as { error: { status: string } };
    assert.strictEqual(j.error.status, "NOT_FOUND");
  });

  test("malformed JSON body is 400 text/plain", async () => {
    const r = await setup(fake(() => parts([]))).call("generateContent", null, {
      raw: "{bad",
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
  });

  test("fileData is accepted and passed as text", async () => {
    const r = await setup(fake(() => parts([]))).call("generateContent", {
      contents: [
        {
          role: "user",
          parts: [{ fileData: { fileUri: "gs://x", mimeType: "a/b" } }],
        },
      ],
    });
    assert.strictEqual(r.status, 200);
  });

  test("Copilot 400 becomes Google error envelope and is journaled", async () => {
    const s = setup(
      fake(() => parts([]), {
        throwOnSend: new Error(
          'Request Failed: 400 {"error":{"message":"bad"}}',
        ),
      }),
    );
    const r = await s.call("generateContent", userHi);
    assert.strictEqual(r.status, 400);
    const j = (await r.json()) as {
      error: { status: string; message: string };
    };
    assert.strictEqual(j.error.status, "INVALID_ARGUMENT");
    assert.match(j.error.message, /bad/);
    assert.deepStrictEqual(s.errs, ["upstream_rejected"]);
  });

  test("NoPermissions maps to 403 PERMISSION_DENIED", async () => {
    const err = Object.assign(new Error("no"), { code: "NoPermissions" });
    const r = await setup(fake(() => parts([]), { throwOnSend: err })).call(
      "generateContent",
      userHi,
    );
    assert.strictEqual(r.status, 403);
    const j = (await r.json()) as { error: { status: string } };
    assert.strictEqual(j.error.status, "PERMISSION_DENIED");
  });

  test("timeout returns 504 DEADLINE_EXCEEDED", async () => {
    const s = setup(
      fake(async function* (t) {
        while (!t.isCancellationRequested) {
          await new Promise((r) => setTimeout(r, 5));
        }
        yield new TextPart("late");
      }),
      20,
    );
    const r = await s.call("generateContent", userHi);
    assert.strictEqual(r.status, 504);
    const j = (await r.json()) as { error: { status: string } };
    assert.strictEqual(j.error.status, "DEADLINE_EXCEEDED");
  });

  test("client abort mid-stream writes no terminal chunk", async () => {
    const ac = new AbortController();
    const { call } = setup(
      fake(async function* (t) {
        yield new TextPart("a");
        ac.abort();
        await new Promise((r) => setTimeout(r, 5));
        if (!t.isCancellationRequested) {
          yield new TextPart("b");
        }
        yield usagePart;
      }),
    );
    const r = await call("streamGenerateContent", userHi, {
      query: "?alt=sse",
      signal: ac.signal,
    });
    let text = "";
    try {
      text = await r.text();
    } catch {
      // cancelled stream may reject; that is also "no terminal"
    }
    assert.ok(!text.includes("finishReason"), text);
  });

  test("settings log line is written with resolved model", async () => {
    const s = setup(fake(() => parts([new TextPart("x"), usagePart])));
    const r = await s.call("generateContent", {
      ...userHi,
      generationConfig: { maxOutputTokens: 50 },
    });
    await r.text();
    const line = s.logs.find((l) => l.includes("settings"));
    assert.ok(line, s.logs.join("\n"));
    assert.match(line, /rid-g/);
    assert.match(line, /copilot-m/);
    assert.match(line, /max_tokens=50/);
  });
});
