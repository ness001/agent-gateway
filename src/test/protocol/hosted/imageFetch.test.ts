import * as assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";

import { imageLookup } from "../../../protocol/hosted/imageFetch";
import { downloadImage } from "../../../protocol/hosted/imageLinks";

import dns = require("node:dns");
import http = require("node:http");

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

suite("protocol/hosted/imageFetch", () => {
  const originalLookup = dns.lookup;
  const originalRequest = http.request;
  teardown(() => {
    dns.lookup = originalLookup;
    http.request = originalRequest;
  });

  function resolveTo(addresses: LookupAddress[]): void {
    const fake: LookupFunction = (_hostname, options, callback) => {
      assert.equal(options.all, true);
      callback(null, addresses);
    };
    dns.lookup = fake as typeof dns.lookup;
  }

  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    test(`rejects DNS answer ${address}, including mixed public/private answers`, async () => {
      for (const mixed of [false, true]) {
        resolveTo([
          ...(mixed ? [{ address: "93.184.215.14", family: 4 }] : []),
          { address, family: address.includes(":") ? 6 : 4 },
        ]);
        await new Promise<void>((resolve) => {
          imageLookup(
            "image.example.com",
            { all: true },
            (error, addresses) => {
              assert.equal(error?.message, "unsafe");
              assert.deepEqual(addresses, []);
              resolve();
            },
          );
        });
      }
    });
  }

  test("returns validated public addresses from one lookup for both socket modes", async () => {
    const addresses = [
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    for (const all of [false, true]) {
      let lookups = 0;
      const fake: LookupFunction = (_hostname, _options, callback) => {
        lookups++;
        callback(
          null,
          lookups === 1 ? addresses : [{ address: "127.0.0.1", family: 4 }],
        );
      };
      dns.lookup = fake as typeof dns.lookup;
      await new Promise<void>((resolve) => {
        imageLookup("image.example.com", { all }, (error, result, family) => {
          assert.equal(error, null);
          assert.deepEqual(result, all ? addresses : addresses[0].address);
          if (!all) {
            assert.equal(family, 4);
          }
          resolve();
        });
      });
      assert.equal(lookups, 1);
    }
  });

  test("public image transport keeps Host, decodes gzip and rechecks redirect DNS", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      assert.match(req.headers.host ?? "", /^image\.example\.com:/);
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers.authorization, undefined);
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://private.example.com/image" });
        res.end();
      } else {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(PNG));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const fake: LookupFunction = (host, _options, callback) =>
      callback(null, [
        {
          address:
            host === "private.example.com" ? "127.0.0.1" : "93.184.215.14",
          family: 4,
        },
      ]);
    dns.lookup = fake as typeof dns.lookup;
    // Redirect validated public sockets to the test server, without changing
    // the URL/Host seen by the transport or bypassing its DNS validation.
    http.request = ((
      url: string,
      options: http.RequestOptions,
      callback: (res: http.IncomingMessage) => void,
    ) => {
      assert.equal(options.agent, false);
      const checkedLookup = options.lookup!;
      const localLookup: LookupFunction = (host, opts, done) =>
        checkedLookup(host, opts, (error, addresses) => {
          if (error) {
            done(error, []);
            return;
          }
          assert.ok(Array.isArray(addresses));
          assert.equal(addresses[0].address, "93.184.215.14");
          done(
            null,
            opts.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
            4,
          );
        });
      return originalRequest(
        url,
        { ...options, lookup: localLookup },
        callback,
      );
    }) as typeof http.request;
    try {
      const image = await downloadImage(
        `http://image.example.com:${port}/image`,
        { signal: new AbortController().signal },
      );
      assert.deepEqual(Buffer.from(image.data), PNG);
      assert.equal(image.mime, "image/png");
      await assert.rejects(
        downloadImage(`http://image.example.com:${port}/redirect`, {
          signal: new AbortController().signal,
        }),
        { message: "unsafe" },
      );
      assert.equal(hits, 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
