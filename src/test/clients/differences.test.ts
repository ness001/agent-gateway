import * as assert from "node:assert/strict";

import {
  describeDifferences,
  redactConfigCredentials,
} from "../../clients/differences";

suite("client configuration differences", () => {
  test("explains changed setting categories without returning values", () => {
    const result = describeDifferences({
      changes: [
        {
          path: "settings.json",
          before:
            '{\n"base_url": "http://old",\n"api_key": "old-secret",\n"model": "old"\n}',
          after:
            '{\n"base_url": "http://new",\n"api_key": "new-secret",\n"model": "new"\n}',
        },
      ],
      summary: [],
    });
    assert.deepEqual(result, ["gateway URL", "API key", "default model"]);
    assert.ok(!result.join().includes("secret"));
  });
  test("redacts old and new credentials in JSON, TOML, YAML and env previews", () => {
    for (const text of [
      '{"apiKey":"old-secret"}',
      'api_key = "new-secret"',
      "ANTHROPIC_AUTH_TOKEN=x",
      'Authorization: "Bearer private-token"',
      "password: xyz",
    ]) {
      const output = redactConfigCredentials(text);
      assert.ok(output.includes("<redacted>"), output);
      for (const value of [
        "old-secret",
        "new-secret",
        "private-token",
        "xyz",
      ]) {
        assert.ok(!output.includes(value));
      }
    }
  });
});
