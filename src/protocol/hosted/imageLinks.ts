import { sniffImageMime } from "../core/images";
import { createSafeLogger } from "../core/log";
import type {
  CoreLogger,
  CoreRequest,
  ImagePart,
  Part,
  TextPart,
} from "../core/types";
import { checkUrl } from "./urlSafety";

/** Per-image download timeout (same as URL fetch). */
export const IMAGE_TIMEOUT_MS = 30_000;
/** Safety cap per downloaded image, protecting extension host memory. */
export const MAX_LINKED_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_REDIRECTS = 3;

export type ImageLinkFailure =
  | "unsafe"
  | "network"
  | "status"
  | "timeout"
  | "too_large"
  | "not_image"
  | "redirects";

class LinkError extends Error {
  constructor(readonly kind: ImageLinkFailure) {
    super(kind);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) {
    return new Uint8Array(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new LinkError("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Downloads one image link. Every hop (including redirects) must pass the
 * URL safety rules; no cookies or credentials are sent. The bytes must be a
 * recognised image format.
 */
export async function downloadImage(
  url: string,
  o: {
    signal: AbortSignal;
    fetch?: FetchLike;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<ImagePart> {
  const doFetch = o.fetch ?? ((u, init) => fetch(u, init));
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(),
    o.timeoutMs ?? IMAGE_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!checkUrl(current).safe) {
        throw new LinkError("unsafe");
      }
      let res: Response;
      try {
        res = await doFetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: { "user-agent": "agent-gateway", accept: "image/*" },
          signal,
        });
      } catch {
        throw new LinkError(timeout.signal.aborted ? "timeout" : "network");
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) {
          throw new LinkError("status");
        }
        if (hop >= MAX_IMAGE_REDIRECTS) {
          throw new LinkError("redirects");
        }
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new LinkError("status");
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, o.maxBytes ?? MAX_LINKED_IMAGE_BYTES);
      } catch (e) {
        if (e instanceof LinkError) {
          throw e;
        }
        throw new LinkError(timeout.signal.aborted ? "timeout" : "network");
      }
      const mime = sniffImageMime(bytes);
      if (!mime) {
        throw new LinkError("not_image");
      }
      return { type: "image", mime, data: bytes };
    }
  } finally {
    clearTimeout(timer);
  }
}

function failureKind(e: unknown): ImageLinkFailure {
  return e instanceof LinkError ? e.kind : "network";
}

/**
 * Replaces image-link text parts with downloaded images, all in parallel.
 * A failed download keeps the text description and logs one info line with
 * the protocol and failure kind (never the URL).
 */
export async function resolveImageLinks(
  req: CoreRequest,
  o: {
    signal: AbortSignal;
    logger?: CoreLogger;
    requestId?: string;
    fetch?: FetchLike;
  },
): Promise<CoreRequest> {
  const links: TextPart[] = [];
  const collect = (parts: readonly unknown[]) => {
    for (const p of parts as Part[]) {
      if (p.type === "text" && p.imageUrl) {
        links.push(p);
      } else if (p.type === "toolResult") {
        collect(p.content);
      }
    }
  };
  for (const t of req.turns) {
    collect(t.parts);
  }
  if (!links.length) {
    return req;
  }
  const log = createSafeLogger(o.logger, {
    requestId: o.requestId,
    protocol: req.protocol,
  });
  const done = new Map<TextPart, ImagePart>();
  await Promise.all(
    links.map(async (p) => {
      try {
        done.set(
          p,
          await downloadImage(p.imageUrl!, {
            signal: o.signal,
            fetch: o.fetch,
          }),
        );
      } catch (e) {
        if (!o.signal.aborted) {
          log.info("image.link", { kind: failureKind(e) });
        }
      }
    }),
  );
  const swap = <T extends Part | TextPart | ImagePart>(p: T): T =>
    (p.type === "text" ? (done.get(p) ?? p) : p) as T;
  return {
    ...req,
    turns: req.turns.map((t) => ({
      ...t,
      parts: t.parts.map((p) =>
        p.type === "toolResult"
          ? { ...p, content: p.content.map(swap) }
          : swap(p),
      ),
    })),
  };
}

/** {@link resolveImageLinks} bound to a request scope's cancellation. */
export function resolveImageLinksInScope(
  req: CoreRequest,
  scope: {
    readonly requestId: string;
    onCancel(fn: () => void): void;
    readonly reason: unknown;
  },
  o: { logger?: CoreLogger; fetch?: FetchLike },
): Promise<CoreRequest> {
  const abort = new AbortController();
  if (scope.reason) {
    abort.abort();
  }
  scope.onCancel(() => abort.abort());
  return resolveImageLinks(req, {
    signal: abort.signal,
    logger: o.logger,
    requestId: scope.requestId,
    fetch: o.fetch,
  });
}
