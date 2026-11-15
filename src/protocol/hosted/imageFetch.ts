import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type LookupFunction, isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { checkUrl } from "./urlSafety";

export class UnsafeImageAddressError extends Error {
  constructor() {
    super("unsafe");
  }
}

/** Validates the addresses the socket will actually use, not a preflight lookup. */
export const imageLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    if (
      !addresses.length ||
      addresses.some(({ address }) => {
        const family = isIP(address);
        const host = family === 6 ? `[${address}]` : address;
        return !family || !checkUrl(`http://${host}/`).safe;
      })
    ) {
      callback(new UnsafeImageAddressError(), []);
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
};

/** One GET hop, with no pooling or redirects that could bypass address checks. */
export function fetchImage(url: string, init: RequestInit): Promise<Response> {
  const checked = checkUrl(url);
  if (!checked.safe) {
    return Promise.reject(new UnsafeImageAddressError());
  }
  return new Promise((resolve, reject) => {
    const request =
      checked.url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const req = request(
      url,
      {
        method: "GET",
        headers,
        signal: init.signal ?? undefined,
        agent: false,
        lookup: imageLookup,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) {
            responseHeaders.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
          }
        }
        const status = res.statusCode ?? 502;
        if (status === 204 || status === 205 || status === 304) {
          res.destroy();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const encoding = responseHeaders.get("content-encoding");
        const decoder =
          encoding === "gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : undefined;
        let body: Readable = res;
        if (decoder) {
          res.on("error", (error) => decoder.destroy(error));
          decoder.on("close", () => res.destroy());
          body = res.pipe(decoder);
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        resolve(
          new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
