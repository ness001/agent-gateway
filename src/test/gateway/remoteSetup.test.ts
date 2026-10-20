import * as assert from "assert";

import {
  deriveRemoteName,
  mergeRemote,
  removeRemote,
  validateRemoteName,
  validateRemoteUrl,
} from "../../gateway/remoteSetup";

suite("remoteSetup", () => {
  test("URL validation reuses remoteConfig rules", () => {
    assert.deepStrictEqual(
      validateRemoteUrl("https://abc-24445.jpe1.devtunnels.ms/"),
      { url: "https://abc-24445.jpe1.devtunnels.ms" },
    );
    assert.deepStrictEqual(validateRemoteUrl("http://host:8080"), {
      url: "http://host:8080",
    });
    for (const bad of ["", "ftp://x", "https://x/path", "https://u:p@x", "x"]) {
      const r = validateRemoteUrl(bad);
      assert.ok("error" in r, bad);
      assert.match((r as { error: string }).error, /^URL must/);
    }
  });

  test("name derivation", () => {
    assert.strictEqual(
      deriveRemoteName("https://99vsjvtz-24445.jpe1.devtunnels.ms"),
      "99vsjvtz",
    );
    assert.strictEqual(deriveRemoteName("http://workbox.corp:9"), "workbox");
    assert.strictEqual(deriveRemoteName("http://127.0.0.1:9"), "127");
    assert.strictEqual(deriveRemoteName("nope"), "remote");
  });

  test("name validation", () => {
    assert.strictEqual(validateRemoteName("box-1", []), undefined);
    assert.match(validateRemoteName("", [])!, /required/);
    assert.match(validateRemoteName("-x", [])!, /must start/);
    assert.match(validateRemoteName("a b", [])!, /must start/);
    assert.match(validateRemoteName("box", ["box"])!, /already exists/);
    assert.strictEqual(validateRemoteName("box", ["box"], true), undefined);
  });

  test("merge appends, replaces URL by name and keeps other entries", () => {
    const current = [{ name: "a", url: "http://a" }, { bogus: true }];
    const added = mergeRemote(current, { name: "b", url: "http://b" });
    assert.strictEqual(added.replaced, false);
    assert.deepStrictEqual(added.value, [
      ...current,
      { name: "b", url: "http://b" },
    ]);
    const replaced = mergeRemote(current, { name: "a", url: "http://a2" });
    assert.strictEqual(replaced.replaced, true);
    assert.deepStrictEqual(replaced.value[0], { name: "a", url: "http://a2" });
    assert.deepStrictEqual(current[0], { name: "a", url: "http://a" });
    assert.deepStrictEqual(
      mergeRemote(undefined, { name: "c", url: "http://c" }).value,
      [{ name: "c", url: "http://c" }],
    );
  });

  test("remove by name", () => {
    assert.deepStrictEqual(
      removeRemote(
        [
          { name: "a", url: "http://a" },
          { name: "b", url: "http://b" },
        ],
        "a",
      ),
      [{ name: "b", url: "http://b" }],
    );
    assert.deepStrictEqual(removeRemote(undefined, "a"), []);
  });
});
