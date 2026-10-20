import type { CoreLogger, GatewayErrorInfo } from "./types";

export type SniffedMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp";

export interface DecodedImage {
  mime: string;
  bytes: Uint8Array;
}

/** Thrown for undecodable images; maps to HTTP 400. */
export class ImageInputError extends Error {
  readonly status = 400;
  readonly info: GatewayErrorInfo;
  constructor(message: string, param?: string) {
    super(message);
    this.name = "ImageInputError";
    this.info = { kind: "invalid_request", message, param };
  }
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Identify an image by its magic bytes; undefined when not recognised. */
export function sniffImageMime(bytes: Uint8Array): SniffedMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  if (bytes.length >= 26 && startsWith(bytes, [0x42, 0x4d])) {
    return "image/bmp";
  }
  return undefined;
}

export interface ParsedDataUrl {
  mime?: string;
  base64: boolean;
  payload: string;
}

/** Parse an RFC 2397 data URL; undefined if the string is not one. */
export function parseDataUrl(url: string): ParsedDataUrl | undefined {
  const trimmed = url.trim();
  // No regex: the payload can be several megabytes.
  const comma = trimmed.indexOf(",");
  if (!trimmed.startsWith("data:") || comma < 0) {
    return undefined;
  }
  const params = trimmed
    .slice(5, comma)
    .split(";")
    .map((p) => p.trim());
  const base64 = params.slice(1).some((p) => p.toLowerCase() === "base64");
  const mime = params[0] ? params[0].toLowerCase() : undefined;
  return { mime, base64, payload: trimmed.slice(comma + 1) };
}

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The bytes as a Uint8Array, without copying when they own their memory. */
function asUint8Array(buf: Buffer): Uint8Array {
  return buf.byteOffset === 0 && buf.buffer.byteLength === buf.length
    ? new Uint8Array(buf.buffer)
    : new Uint8Array(buf);
}

function decodeBase64(data: string, param?: string): Uint8Array {
  // Fast path: canonical padded base64 re-encodes to itself, and always
  // satisfies the checks below.
  const direct = Buffer.from(data, "base64");
  if (direct.toString("base64") === data) {
    return asUint8Array(direct);
  }
  const clean = data.replace(/\s+/g, "");
  if (!B64.test(clean) || clean.length % 4 === 1) {
    throw new ImageInputError("Image data is not valid base64.", param);
  }
  return asUint8Array(Buffer.from(clean, "base64"));
}

export interface DecodeImageOptions {
  /** Mime declared by the client, if any. */
  declaredMime?: string;
  /** Protocol parameter path for error reporting. */
  param?: string;
  logger?: CoreLogger;
}

function resolveMime(
  bytes: Uint8Array,
  declared: string | undefined,
  logger?: CoreLogger,
): string {
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    return declared || "application/octet-stream";
  }
  const alias = declared === "image/jpg" ? "image/jpeg" : declared;
  if (alias && alias !== sniffed) {
    // Never log the bytes themselves.
    logger?.debug(
      `image mime overridden: declared ${declared}, sniffed ${sniffed} (${bytes.length} bytes)`,
    );
  }
  return sniffed;
}

/**
 * Decode a base64 string or data URL into bytes. The sniffed type wins over
 * the declared one (a debug note is logged; bytes never are). Unrecognised
 * content keeps the declared mime, defaulting to application/octet-stream.
 * Bytes are not transformed.
 */
export function decodeImage(
  input: string,
  opts: DecodeImageOptions = {},
): DecodedImage {
  const { param, logger } = opts;
  let declared = opts.declaredMime?.toLowerCase();
  let bytes: Uint8Array;
  if (input.trimStart().startsWith("data:")) {
    const url = parseDataUrl(input);
    if (!url) {
      throw new ImageInputError("Malformed data URL.", param);
    }
    declared = url.mime ?? declared;
    if (url.base64) {
      bytes = decodeBase64(url.payload, param);
    } else {
      let text: string;
      try {
        text = decodeURIComponent(url.payload);
      } catch {
        throw new ImageInputError("Malformed data URL.", param);
      }
      bytes = new Uint8Array(Buffer.from(text, "latin1"));
    }
  } else {
    bytes = decodeBase64(input, param);
  }
  if (bytes.length === 0) {
    throw new ImageInputError("Image data is empty.", param);
  }
  return { mime: resolveMime(bytes, declared, logger), bytes };
}

/** Sniff already-decoded bytes (returns the same array). */
export function normalizeImageBytes(
  bytes: Uint8Array,
  opts: DecodeImageOptions = {},
): DecodedImage {
  return {
    mime: resolveMime(bytes, opts.declaredMime?.toLowerCase(), opts.logger),
    bytes,
  };
}

/** Placeholder for inline data that is not passed to the model. */
export function omittedData(data: string): string {
  const clean = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  return `<omitted ${bytes} bytes>`;
}

/**
 * Text stand-in for an input part the model cannot take directly (remote
 * image links, file references, audio): a compact JSON description of the
 * part's reference fields. Only the part type is logged.
 */
export function describedPart(
  fields: Record<string, unknown>,
  protocol: string,
  logger?: CoreLogger,
): { type: "text"; text: string; imageUrl?: string } {
  const desc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      desc[k] = v;
    }
  }
  logger?.debug(
    `${protocol}: ${String(desc.type)} part passed to the model as text`,
  );
  return { type: "text", text: JSON.stringify(desc) };
}

/** Text stand-in for a remote image link, marked for download. */
export function imageLinkPart(
  fields: Record<string, unknown>,
  url: string,
  protocol: string,
  logger?: CoreLogger,
): { type: "text"; text: string; imageUrl: string } {
  return { ...describedPart(fields, protocol, logger), imageUrl: url };
}
