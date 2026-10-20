import * as assert from "assert";

import {
  ImageInputError,
  decodeImage,
  normalizeImageBytes,
  parseDataUrl,
  sniffImageMime,
} from "../../../protocol/core/images";
import type { CoreLogger } from "../../../protocol/core/types";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56,
]);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

function recLogger(): CoreLogger & { lines: string[] } {
  const lines: string[] = [];
  const f = (m: string): void => void lines.push(m);
  return { lines, error: f, warn: f, info: f, debug: f };
}

suite("protocol/core/images", () => {
  test("sniffs png, jpeg, gif and webp", () => {
    assert.strictEqual(sniffImageMime(PNG), "image/png");
    assert.strictEqual(sniffImageMime(JPEG), "image/jpeg");
    assert.strictEqual(sniffImageMime(GIF), "image/gif");
    assert.strictEqual(sniffImageMime(WEBP), "image/webp");
    assert.strictEqual(sniffImageMime(Uint8Array.from([1, 2, 3])), undefined);
  });

  test("PNG declared as JPEG is sniffed as PNG with a debug note and no bytes", () => {
    const log = recLogger();
    const out = decodeImage(b64(PNG), {
      declaredMime: "image/jpeg",
      logger: log,
    });
    assert.strictEqual(out.mime, "image/png");
    assert.deepStrictEqual(Array.from(out.bytes), Array.from(PNG));
    assert.strictEqual(log.lines.length, 1);
    assert.ok(!log.lines[0].includes(b64(PNG)));
  });

  test("data URL decoded and its mime corrected", () => {
    const out = decodeImage(`data:image/gif;base64,${b64(WEBP)}`);
    assert.strictEqual(out.mime, "image/webp");
    assert.strictEqual(out.bytes.length, WEBP.length);
    assert.deepStrictEqual(parseDataUrl("data:image/png;base64,QQ=="), {
      mime: "image/png",
      base64: true,
      payload: "QQ==",
    });
  });

  test("unknown content keeps declared mime", () => {
    const out = decodeImage(b64(Uint8Array.from([9, 9, 9])), {
      declaredMime: "image/bmp",
    });
    assert.strictEqual(out.mime, "image/bmp");
  });

  test("large images are accepted without a size limit", () => {
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.strictEqual(
      decodeImage(Buffer.from(big).toString("base64")).bytes.length,
      big.length,
    );
    assert.strictEqual(normalizeImageBytes(big).mime, "image/png");
  });

  test("invalid base64, empty data and malformed data URL are 400", () => {
    assert.throws(() => decodeImage("not base64!!"), ImageInputError);
    assert.throws(() => decodeImage("data:image/png;base64"), ImageInputError);
    assert.throws(() => decodeImage(""), ImageInputError);
  });

  test("result is {mime, bytes} suitable for a data part", () => {
    const out = decodeImage(b64(JPEG), { declaredMime: "image/jpeg" });
    assert.ok(out.bytes instanceof Uint8Array);
    assert.strictEqual(out.mime, "image/jpeg");
  });

  test("bytes are passed through without transformation", () => {
    const payload = new Uint8Array(4096);
    payload.set(PNG);
    for (let i = PNG.length; i < payload.length; i++) {
      payload[i] = i % 251;
    }
    const out = decodeImage(b64(payload));
    assert.deepStrictEqual(Buffer.from(out.bytes), Buffer.from(payload));
    assert.strictEqual(normalizeImageBytes(payload).bytes, payload);
  });
});
