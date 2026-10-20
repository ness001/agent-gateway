import * as assert from "node:assert/strict";

import {
  ID_PREFIX,
  type IdKind,
  idPattern,
  newId,
} from "../../../protocol/core/ids";

suite("protocol/core/ids", () => {
  test("ids use protocol prefixes", () => {
    assert.match(newId("response"), /^resp_[A-Za-z0-9]+$/);
    assert.match(newId("responseMessage"), /^msg_[A-Za-z0-9]+$/);
    assert.match(newId("functionCallItem"), /^fc_/);
    assert.match(newId("callId"), /^call_/);
    assert.match(newId("chatCompletion"), /^chatcmpl-[A-Za-z0-9]+$/);
    assert.match(newId("anthropicToolUse"), /^toolu_/);
    assert.match(newId("anthropicServerToolUse"), /^srvtoolu_/);
    assert.match(newId("webSearchCall"), /^ws_/);
  });
  test("every kind matches its pattern and ids are unique", () => {
    const seen = new Set<string>();
    for (const k of Object.keys(ID_PREFIX) as IdKind[]) {
      for (let i = 0; i < 200; i++) {
        const id = newId(k);
        assert.match(id, idPattern(k));
        assert.ok(!seen.has(id));
        seen.add(id);
      }
    }
  });
});
