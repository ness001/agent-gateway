import type { GatewayErrorInfo, GatewayErrorKind } from "../core/types";

export type BodyErrorReason = "MalformedJson";

/** Body read failure. Maps to kind `invalid_request` (HTTP 400). */
export class BodyError extends Error implements GatewayErrorInfo {
  readonly kind: GatewayErrorKind = "invalid_request";
  constructor(
    readonly reason: BodyErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/** Minimal structural view of a fetch `Request`. */
export interface BodySource {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export async function readText(req: BodySource): Promise<string> {
  if (!req.body) {
    return "";
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new BodyError("MalformedJson", "Request body is not valid UTF-8.");
  }
}

const parsedBodies = new WeakMap<object, unknown>();

/**
 * Hand an already-parsed JSON body to `readJson` along with the request, so a
 * caller that parsed the body to route it does not make the handler read and
 * parse it again. The request body must still carry the same JSON.
 */
export function attachParsedBody(req: object, value: unknown): void {
  parsedBodies.set(req, value);
}

/** A request body stream that serialises its text only if it is read. */
export function lazyBody(text: () => string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(text()));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

export async function readJson(req: BodySource): Promise<unknown> {
  if (parsedBodies.has(req)) {
    return parsedBodies.get(req);
  }
  const text = await readText(req);
  if (text.trim() === "") {
    throw new BodyError("MalformedJson", "Request body is empty.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new BodyError(
      "MalformedJson",
      `Malformed JSON in request body: ${(e as Error).message}`,
    );
  }
}
