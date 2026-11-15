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
  test("redacts credentials inside escaped restoration snapshots", () => {
    const old = "old-private-credential";
    const text = JSON.stringify({
      env: {
        AGENT_GATEWAY_PREVIOUS: JSON.stringify({ ANTHROPIC_AUTH_TOKEN: old }),
      },
    });
    const output = redactConfigCredentials(text);
    assert.ok(!output.includes(old), output);
    assert.ok(output.includes("<redacted>"));
  });
  test("formatting, property order and restoration data are not setting differences", () => {
    assert.deepEqual(
      describeDifferences({
        changes: [
          {
            path: "settings.json",
            before:
              '{"env":{"ANTHROPIC_MODEL":"m","AGENT_GATEWAY_PREVIOUS":"old"}}',
            after:
              '{\n"env": {"AGENT_GATEWAY_PREVIOUS":"new", "ANTHROPIC_MODEL":"m"}\n}',
          },
        ],
        summary: [],
      }),
      [],
    );
  });
  test("TOML assignment spacing and comments are not semantic differences", () => {
    assert.deepEqual(
      describeDifferences({
        changes: [
          {
            path: "config.toml",
            before:
              'model="m" # selected\n[features]\napi_key_model_discovery=true\n',
            after: 'model = "m"\n[features]\napi_key_model_discovery = true\n',
          },
        ],
        summary: [],
      }),
      [],
    );
  });
  test("redacts env text embedded in JSON restoration data", () => {
    const output = redactConfigCredentials(
      JSON.stringify({
        envBefore: "GEMINI_API_KEY=old-private-credential\nOTHER=ok",
      }),
    );
    assert.ok(!output.includes("old-private-credential"));
    assert.ok(output.includes("OTHER=ok"));
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
