import * as assert from "node:assert/strict";

import type {
  CoreLogger,
  CoreRequest,
  ImagePart,
  TextPart,
} from "../../../protocol/core/types";
import {
  type FetchLike,
  downloadImage,
  resolveImageLinks,
} from "../../../protocol/hosted/imageLinks";

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const URL_A = "https://img.example.com/a";

function stub(
  routes: Record<string, () => Response | Promise<Response>>,
): FetchLike & { seen: Array<{ url: string; init: RequestInit }> } {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = routes[url];
    if (!r) {
      throw new TypeError("network");
    }
    return r();
  }) as FetchLike & { seen: typeof seen };
  f.seen = seen;
  return f;
}

const ok = (
  body: Uint8Array<ArrayBuffer> | string,
  type = "application/octet-stream",
) => new Response(body, { status: 200, headers: { "content-type": type } });

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "ok";
};

const signal = () => new AbortController().signal;

suite("protocol/hosted/imageLinks", () => {
  test("PNG served as application/octet-stream is sniffed as image/png", async () => {
    const f = stub({ [URL_A]: () => ok(PNG) });
    const img = await downloadImage(URL_A, { signal: signal(), fetch: f });
    assert.equal(img.mime, "image/png");
    assert.deepEqual([...img.data], [...PNG]);
    const init = f.seen[0].init;
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.deepEqual(init.headers, {
      "user-agent": "agent-gateway",
      accept: "image/*",
    });
  });

  test("redirects are followed and each target is re-checked", async () => {
    const hop = (to: string) => () =>
      new Response(null, { status: 302, headers: { location: to } });
    const good = stub({
      [URL_A]: hop("/b"),
      "https://img.example.com/b": () => ok(PNG),
    });
    assert.equal(
      (await downloadImage(URL_A, { signal: signal(), fetch: good })).mime,
      "image/png",
    );
    const priv = stub({ [URL_A]: hop("http://10.0.0.5/x") });
    assert.equal(
      await kindOf(downloadImage(URL_A, { signal: signal(), fetch: priv })),
      "unsafe",
    );
    assert.equal(priv.seen.length, 1);
    const loop = stub({ [URL_A]: hop(URL_A) });
    assert.equal(
      await kindOf(downloadImage(URL_A, { signal: signal(), fetch: loop })),
      "redirects",
    );
    assert.equal(loop.seen.length, 4);
  });

  test("unsafe, non-image, oversize and timeout fail", async () => {
    const f = stub({});
    assert.equal(
      await kindOf(
        downloadImage("http://localhost/a.png", { signal: signal(), fetch: f }),
      ),
      "unsafe",
    );
    assert.equal(f.seen.length, 0);
    const html = stub({ [URL_A]: () => ok("<html></html>", "image/png") });
    assert.equal(
      await kindOf(downloadImage(URL_A, { signal: signal(), fetch: html })),
      "not_image",
    );
    const big = stub({ [URL_A]: () => ok(new Uint8Array(100)) });
    assert.equal(
      await kindOf(
        downloadImage(URL_A, { signal: signal(), fetch: big, maxBytes: 50 }),
      ),
      "too_large",
    );
    const hang: FetchLike = (_u, init) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    assert.equal(
      await kindOf(
        downloadImage(URL_A, { signal: signal(), fetch: hang, timeoutMs: 10 }),
      ),
      "timeout",
    );
  });

  test("client abort stops the download", async () => {
    const ac = new AbortController();
    const hang: FetchLike = (_u, init) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    const p = downloadImage(URL_A, { signal: ac.signal, fetch: hang });
    ac.abort();
    assert.equal(await kindOf(p), "network");
  });

  const req = (parts: CoreRequest["turns"][0]["parts"]): CoreRequest =>
    ({
      protocol: "openai-chat",
      turns: [{ role: "user", parts }],
    }) as unknown as CoreRequest;
  const link = (url: string): TextPart => ({
    type: "text",
    text: `{"type":"image_url","url":"${url}"}`,
    imageUrl: url,
  });

  test("resolve replaces links with images and keeps text on failure", async () => {
    const lines: string[] = [];
    const push = (m: string) => lines.push(m);
    const logger: CoreLogger = {
      error: push,
      warn: push,
      info: push,
      debug: push,
    };
    const bad = "https://img.example.com/missing";
    const out = await resolveImageLinks(
      req([
        { type: "text", text: "look" },
        link(URL_A),
        link(bad),
        {
          type: "toolResult",
          callId: "c",
          isError: false,
          content: [link(URL_A)],
        },
      ]),
      {
        signal: signal(),
        logger,
        fetch: stub({ [URL_A]: () => ok(PNG) }),
      },
    );
    const parts = out.turns[0].parts;
    assert.equal(parts[0].type, "text");
    assert.equal((parts[1] as ImagePart).mime, "image/png");
    assert.deepEqual(parts[2], link(bad));
    const tr = parts[3] as { content: ImagePart[] };
    assert.equal(tr.content[0].type, "image");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /image\.link/);
    assert.match(lines[0], /kind=network/);
    assert.ok(!lines.join("\n").includes("example.com"));
  });

  test("requests without links are returned unchanged", async () => {
    const r = req([{ type: "text", text: "hi" }]);
    assert.equal(await resolveImageLinks(r, { signal: signal() }), r);
  });
});
