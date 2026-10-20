import { serve } from "@hono/node-server";
import * as assert from "node:assert";
import * as http from "node:http";
import { performance } from "node:perf_hooks";

import { createGatewayApp } from "../../gateway/app";
import { buildRegistry } from "../../gateway/catalog";
import { toModelInfo } from "../../gateway/discovery";
import { createLocalHandler } from "../../gateway/localRoutes";
import { currentRequestContext } from "../../gateway/requestContext";
import type { LmChatLike } from "../../protocol/core/types";
import { budgetFor, record } from "./results";

// The gateway's own cost, with a fake model that answers at once, over real
// loopback HTTP: request overhead (request received -> model called: body
// read, routing, decode, LM request), per-chunk overhead (model yields a
// chunk -> bytes reach the client: encode, SSE write) and the total for a
// non-streamed request.

const MODEL = "perf-model";
const CHUNKS = 20;
const SIZES = {
  small: { history: 0, runs: 20 },
  large: { history: 200, runs: 12 },
};

interface Timing {
  received: number;
  modelCalled?: number;
  yields: number[];
}
const timings = new Map<string, Timing>();

const model = {
  id: MODEL,
  name: MODEL,
  vendor: "copilot",
  family: "perf",
  version: "1",
  maxInputTokens: 10_000_000,
  capabilities: { supportsToolCalling: true },
  countTokens: async () => 1,
  async sendRequest() {
    const t = timings.get(currentRequestContext()?.requestId ?? "");
    if (t) {
      t.modelCalled = performance.now();
    }
    return {
      stream: (async function* () {
        for (let i = 0; i < CHUNKS; i++) {
          // One chunk per event loop turn, as a real stream would arrive.
          await new Promise((r) => setImmediate(r));
          t?.yields.push(performance.now());
          yield { value: `k${i}z lorem ipsum ` };
        }
      })(),
    };
  },
} as unknown as LmChatLike;

const TOOL = {
  name: "read_file",
  description: "Read a file",
  schema: { type: "object", properties: { path: { type: "string" } } },
};
const PROMPT = "Write a short paragraph.";
// ~5 KB per tool result, so 200 turns make a ~1 MB body.
const fileText = (i: number) =>
  `file ${i}: ${"const x = value * 2 + 1; // padding\n".repeat(140)}`;
const turns = (n: number) => Array.from({ length: n }, (_, i) => i);

type Body = (
  history: number,
  stream: boolean,
) => { path: string; body: unknown };
const APIS: Record<string, Body> = {
  anthropic: (h, stream) => ({
    path: "/v1/messages",
    body: {
      model: MODEL,
      max_tokens: 4096,
      stream,
      tools: [
        {
          name: TOOL.name,
          description: TOOL.description,
          input_schema: TOOL.schema,
        },
      ],
      messages: [
        ...turns(h).flatMap((i) => [
          {
            role: "user",
            content: i
              ? [
                  {
                    type: "tool_result",
                    tool_use_id: `t${i - 1}`,
                    content: fileText(i),
                  },
                ]
              : "Read the files.",
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `t${i}`,
                name: TOOL.name,
                input: { path: `f${i}` },
              },
            ],
          },
        ]),
        h
          ? {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `t${h - 1}`,
                  content: fileText(h),
                },
                { type: "text", text: PROMPT },
              ],
            }
          : { role: "user", content: PROMPT },
      ],
    },
  }),
  responses: (h, stream) => ({
    path: "/v1/responses",
    body: {
      model: MODEL,
      stream,
      tools: [
        {
          type: "function",
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.schema,
        },
      ],
      input: [
        ...turns(h).flatMap((i) => [
          {
            type: "function_call",
            call_id: `c${i}`,
            name: TOOL.name,
            arguments: `{"path":"f${i}"}`,
          },
          {
            type: "function_call_output",
            call_id: `c${i}`,
            output: fileText(i),
          },
        ]),
        { role: "user", content: PROMPT },
      ],
    },
  }),
  chat: (h, stream) => ({
    path: "/v1/chat/completions",
    body: {
      model: MODEL,
      stream,
      tools: [
        {
          type: "function",
          function: {
            name: TOOL.name,
            description: TOOL.description,
            parameters: TOOL.schema,
          },
        },
      ],
      messages: [
        ...turns(h).flatMap((i) => [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `c${i}`,
                type: "function",
                function: { name: TOOL.name, arguments: `{"path":"f${i}"}` },
              },
            ],
          },
          { role: "tool", tool_call_id: `c${i}`, content: fileText(i) },
        ]),
        { role: "user", content: PROMPT },
      ],
    },
  }),
  gemini: (h, stream) => ({
    path: `/v1beta/models/${MODEL}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    body: {
      tools: [
        {
          functionDeclarations: [
            {
              name: TOOL.name,
              description: TOOL.description,
              parameters: TOOL.schema,
            },
          ],
        },
      ],
      contents: [
        ...turns(h).flatMap((i) => [
          {
            role: "model",
            parts: [
              { functionCall: { name: TOOL.name, args: { path: `f${i}` } } },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: TOOL.name,
                  response: { content: fileText(i) },
                },
              },
            ],
          },
        ]),
        { role: "user", parts: [{ text: PROMPT }] },
      ],
    },
  }),
};

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };
let port = 0;
let close: () => Promise<void> = async () => {};
let seq = 0;
const agent = new http.Agent({ keepAlive: true });

/** One request; returns client-side total and per-chunk delays. */
function send(path: string, body: Buffer, stream: boolean) {
  const rid = `perf-${++seq}`;
  const t: Timing = { received: 0, yields: [] };
  timings.set(rid, t);
  return new Promise<{ request: number; chunks: number[]; total: number }>(
    (resolve, reject) => {
      const t0 = performance.now();
      const chunks: number[] = [];
      let seen = 0;
      let tail = "";
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          agent,
          headers: { "content-type": "application/json", "x-request-id": rid },
        },
        (res) => {
          res.on("data", (buf: Buffer) => {
            const now = performance.now();
            const text = tail + buf.toString("latin1");
            for (const m of text.matchAll(/k(\d+)z/g)) {
              const i = Number(m[1]);
              if (i >= seen) {
                if (stream) {
                  chunks.push(now - t.yields[i]);
                }
                seen = i + 1;
              }
            }
            tail = text.slice(-8);
          });
          res.on("end", () => {
            timings.delete(rid);
            if (res.statusCode !== 200 || seen !== CHUNKS || !t.modelCalled) {
              reject(
                new Error(`${path}: HTTP ${res.statusCode}, ${seen} chunks`),
              );
              return;
            }
            resolve({
              request: t.modelCalled - t.received,
              chunks,
              total: performance.now() - t0,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}

suite("Performance: gateway overhead", () => {
  suiteSetup(async () => {
    const infos = [toModelInfo(model as never)];
    const registry = buildRegistry(infos, []);
    const app = createGatewayApp({
      getRegistry: () => registry,
      getLocalModels: () => infos,
      handleLocal: createLocalHandler({
        getLocalModel: (id) => (id === MODEL ? (model as never) : undefined),
        maxSearchesPerRequest: 5,
        logger,
        noteRequestError: noop,
      }),
      getRemote: () => undefined,
      getRemoteApiKey: async () => undefined,
      getApiKey: async () => undefined,
      getHealth: () => ({}),
      logger,
    });
    // Stamp arrival as the app receives the request (headers parsed).
    const fetch = (req: Request) => {
      const t = timings.get(req.headers.get("x-request-id") ?? "");
      if (t) {
        t.received = performance.now();
      }
      return app.fetch(req);
    };
    await new Promise<void>((resolve) => {
      const server = serve(
        { fetch, port: 0, hostname: "127.0.0.1" },
        (info) => {
          port = info.port;
          resolve();
        },
      ) as http.Server;
      close = () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
    });
  });

  suiteTeardown(async () => {
    agent.destroy();
    await close();
  });

  for (const [api, build] of Object.entries(APIS)) {
    for (const [size, { history, runs }] of Object.entries(SIZES)) {
      test(`${api} ${size}`, async () => {
        const make = (stream: boolean) => {
          const r = build(history, stream);
          return { path: r.path, body: Buffer.from(JSON.stringify(r.body)) };
        };
        const streamed = make(true);
        const plain = make(false);
        // Warm-up: JIT and connection reuse.
        for (let i = 0; i < 2; i++) {
          await send(streamed.path, streamed.body, true);
          await send(plain.path, plain.body, false);
        }
        const request: number[] = [];
        const chunks: number[] = [];
        const total: number[] = [];
        for (let i = 0; i < runs; i++) {
          const s = await send(streamed.path, streamed.body, true);
          request.push(s.request);
          chunks.push(...s.chunks);
          total.push((await send(plain.path, plain.body, false)).total);
        }
        const group = `${api} ${size}`;
        const kb = Math.round(streamed.body.length / 1024);
        for (const [metric, values, budgetKey] of [
          [`request overhead (${kb} KB)`, request, "requestP95Ms"],
          ["per-chunk overhead", chunks, "chunkP95Ms"],
          ["non-streamed total", total, "nonStreamP95Ms"],
        ] as const) {
          const p95 = record({ group, metric, values, budgetKey });
          const budget = budgetFor({ group, budgetKey });
          assert.ok(
            p95 <= budget,
            `${group} ${metric} p95 ${p95.toFixed(2)} ms > ${budget} ms`,
          );
        }
      });
    }
  }
});
