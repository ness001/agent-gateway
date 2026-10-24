// Run after build-tests: node --test scripts/model-mapping.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const { buildRegistry } = require("../out/gateway/catalog");
const { toModelInfo } = require("../out/gateway/discovery");
const catalog = buildRegistry(
  [toModelInfo({ id: "fast" }), toModelInfo({ id: "balanced" })],
  [],
);
let aliases,
  writes,
  picks,
  answer,
  cancel,
  stage,
  prompts,
  configChanged,
  workspace,
  notices,
  errors,
  apiFail;
const proposals = [
  { source: "claude-haiku-5.5", target: "fast", reason: "Fast role" },
  { source: "claude-sonnet-5", target: "balanced", reason: "Balanced role" },
];
const config = {
  get: () => aliases,
  inspect: () => ({ workspaceValue: workspace ? aliases : undefined }),
  update: async (...args) => writes.push(args),
};
const vscode = {
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 1 },
  LanguageModelChatMessage: { User: (text) => text },
  lm: {
    selectChatModels: async () => [
      {
        id: "fast",
        name: "Fast",
        sendRequest: async (messages) => {
          prompts.push(messages);
          if (apiFail) throw new Error("PRIVATE");
          return {
            text: (async function* () {
              yield answer;
            })(),
          };
        },
      },
    ],
  },
  workspace: { getConfiguration: () => config },
  window: {
    showInputBox: async () =>
      stage === "input" ? undefined : "claude-haiku-5.5, claude-sonnet-5",
    showQuickPick: async (items, options) => {
      picks.push(items);
      if (options.canPickMany) {
        if (configChanged) aliases = { concurrent: "balanced" };
        return stage === "review" ? undefined : items.filter((i) => i.picked);
      }
      return stage === "advisor" ? undefined : items[0];
    },
    withProgress: async (_, task) =>
      task(
        {},
        {
          isCancellationRequested: cancel,
          onCancellationRequested: () => ({ dispose() {} }),
        },
      ),
    showInformationMessage: (m) => notices.push(m),
    showErrorMessage: (m) => errors.push(m),
  },
};
const old = Module._load;
Module._load = function (id, ...args) {
  return id === "vscode" ? vscode : old.call(this, id, ...args);
};
const { initializeModelMappings } = require("../out/commands/modelMapping");
const { setFallbackModel } = require("../out/commands/fallback");
Module._load = old;
const gw = {
  nativeModels: () => catalog,
  health: () => ({ fallbackModel: "fast", fallbackModelSource: "setting" }),
};
function reset() {
  aliases = { unrelated: "balanced", "claude-haiku-5.5": "" };
  writes = [];
  picks = [];
  prompts = [];
  notices = [];
  errors = [];
  answer = JSON.stringify({ mappings: proposals });
  cancel = false;
  stage = "";
  configChanged = false;
  workspace = false;
  apiFail = false;
}
test("saves reviewed new aliases, preserves disabled/existing values and fallback", async () => {
  reset();
  await initializeModelMappings(gw);
  assert.deepEqual(writes, [
    ["modelMappings", { ...aliases, "claude-sonnet-5": "balanced" }, 1],
  ]);
  assert.equal(picks[1][0].picked, false);
  assert.equal(prompts.length, 1);
  assert.equal(errors.length, 0);
});
test("workspace override is updated at effective scope", async () => {
  reset();
  workspace = true;
  await initializeModelMappings(gw);
  assert.equal(writes[0][2], 2);
});
for (const where of ["input", "advisor", "review"])
  test("cancel " + where + " leaves settings unchanged", async () => {
    reset();
    stage = where;
    await initializeModelMappings(gw);
    assert.equal(writes.length, 0);
  });
test("progress cancellation does not save", async () => {
  reset();
  cancel = true;
  await initializeModelMappings(gw);
  assert.equal(writes.length, 0);
});
test("invalid AI response does not save or leak raw provider output", async () => {
  reset();
  answer = "PRIVATE";
  await initializeModelMappings(gw);
  assert.equal(writes.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("PRIVATE"));
});
test("provider failure leaves settings unchanged", async () => {
  reset();
  apiFail = true;
  await initializeModelMappings(gw);
  assert.equal(writes.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("PRIVATE"));
});
test("concurrent settings change is preserved", async () => {
  reset();
  configChanged = true;
  await initializeModelMappings(gw);
  assert.equal(writes.length, 0);
  assert.deepEqual(aliases, { concurrent: "balanced" });
});
test("fallback command dispatches AI option without writing fallbackModel", async () => {
  reset();
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items, o) =>
    o.title === "Fallback model for unknown model names"
      ? items.find((i) => i.action === "initializeMappings")
      : pick(items, o);
  try {
    await setFallbackModel(gw);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "modelMappings");
  } finally {
    vscode.window.showQuickPick = pick;
  }
});

test("explicit review selection may replace an existing disabled entry", async () => {
  reset();
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items, options) =>
    options.canPickMany ? items : pick(items, options);
  try {
    await initializeModelMappings(gw);
    assert.deepEqual(writes[0], [
      "modelMappings",
      {
        unrelated: "balanced",
        "claude-haiku-5.5": "fast",
        "claude-sonnet-5": "balanced",
      },
      1,
    ]);
  } finally {
    vscode.window.showQuickPick = pick;
  }
});
test("target disappearing during review aborts saving", async () => {
  reset();
  const pick = vscode.window.showQuickPick;
  let unavailable = false;
  vscode.window.showQuickPick = async (items, options) => {
    if (options.canPickMany) unavailable = true;
    return pick(items, options);
  };
  try {
    await initializeModelMappings({
      nativeModels: () => (unavailable ? [] : catalog),
    });
    assert.equal(writes.length, 0);
    assert.equal(errors.length, 1);
  } finally {
    vscode.window.showQuickPick = pick;
  }
});
test("normal fallback choice still writes only fallbackModel", async () => {
  reset();
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items) =>
    items.find((i) => i.id === "balanced");
  try {
    await setFallbackModel(gw);
    assert.deepEqual(writes, [["fallbackModel", "balanced", 1]]);
    assert.equal(prompts.length, 0);
  } finally {
    vscode.window.showQuickPick = pick;
  }
});

test("default mapping IDs are present and empty in both settings definitions", () => {
  const pkg = require("../package.json");
  const declared =
    pkg.contributes.configuration.properties["agentGateway.modelMappings"]
      .default;
  const { DEFAULT_CONFIG } = require("../out/utils/config");
  for (const source of ["claude-haiku-5.5", "claude-sonnet-5"]) {
    assert.equal(declared[source], "");
    assert.equal(DEFAULT_CONFIG.modelMappings[source], "");
  }
});
test("review displays and saves an empty suggestion without inventing a target", async () => {
  reset();
  answer = JSON.stringify({
    mappings: proposals.map((p) => ({ ...p, target: "" })),
  });
  await initializeModelMappings(gw);
  assert.ok(picks[1][1].label.includes("(empty — no mapping)"));
  assert.equal(writes[0][1]["claude-sonnet-5"], "");
  assert.equal(writes[0][1]["claude-haiku-5.5"], "");
});

test("fallback reopening lists saved and default mappings and edits without AI", async () => {
  reset();
  aliases = { custom: "balanced", "claude-haiku-5.5": "fast" };
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items, options) => {
    if (options.title === "Fallback model for unknown model names") {
      assert.ok(
        items.some(
          (i) => i.action === "editMapping" && i.id === "claude-sonnet-5",
        ),
      );
      assert.ok(
        items.some((i) => i.action === "editMapping" && i.id === "custom"),
      );
      const row = items.find(
        (i) => i.action === "editMapping" && i.id === "claude-haiku-5.5",
      );
      assert.ok(row.description.includes("fast"));
      return row;
    }
    return items.find((i) => i.id === "balanced");
  };
  try {
    await setFallbackModel(gw);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "modelMappings");
    assert.equal(writes[0][1]["claude-haiku-5.5"], "balanced");
    assert.equal(writes[0][1].custom, "balanced");
    assert.equal(prompts.length, 0);
  } finally {
    vscode.window.showQuickPick = pick;
  }
});
for (const cancelled of [true, false]) {
  test(`manual mapping clear/cancel (cancel=${cancelled})`, async () => {
    reset();
    aliases = { "claude-haiku-5.5": "fast", custom: "balanced" };
    workspace = true;
    const pick = vscode.window.showQuickPick;
    vscode.window.showQuickPick = async (items, options) =>
      options.title === "Fallback model for unknown model names"
        ? items.find(
            (i) => i.action === "editMapping" && i.id === "claude-haiku-5.5",
          )
        : cancelled
          ? undefined
          : items.find((i) => i.id === "");
    try {
      await setFallbackModel(gw);
      if (cancelled) {
        assert.equal(writes.length, 0);
      } else {
        assert.deepEqual(writes, [
          ["modelMappings", { "claude-haiku-5.5": "", custom: "balanced" }, 2],
        ]);
      }
    } finally {
      vscode.window.showQuickPick = pick;
    }
  });
}
test("empty catalog still lets users clear a stale mapping", async () => {
  reset();
  aliases = { "claude-haiku-5.5": "removed" };
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items, options) =>
    options.title === "Fallback model for unknown model names"
      ? items.find(
          (i) => i.action === "editMapping" && i.id === "claude-haiku-5.5",
        )
      : items.find((i) => i.id === "");
  try {
    await setFallbackModel({ ...gw, nativeModels: () => [] });
    assert.equal(writes[0][1]["claude-haiku-5.5"], "");
  } finally {
    vscode.window.showQuickPick = pick;
  }
});

for (const scenario of [
  "unchanged",
  "concurrent",
  "unavailable",
  "write failure",
]) {
  test(`manual mapping ${scenario} does not confirm an unsafe write`, async () => {
    reset();
    aliases = { "claude-haiku-5.5": "fast", custom: "balanced" };
    const pick = vscode.window.showQuickPick;
    const update = config.update;
    let removed = false;
    vscode.window.showQuickPick = async (items, options) => {
      if (options.title === "Fallback model for unknown model names")
        return items.find(
          (i) => i.action === "editMapping" && i.id === "claude-haiku-5.5",
        );
      if (scenario === "concurrent") aliases = { concurrent: "fast" };
      if (scenario === "unavailable") removed = true;
      return items.find(
        (i) => i.id === (scenario === "unchanged" ? "fast" : "balanced"),
      );
    };
    if (scenario === "write failure")
      config.update = async () => {
        throw new Error("failed");
      };
    try {
      await setFallbackModel({
        ...gw,
        nativeModels: () => (removed ? [] : catalog),
      });
      assert.equal(writes.length, 0);
      assert.equal(notices.length, 0);
      assert.equal(errors.length, scenario === "unchanged" ? 0 : 1);
    } finally {
      vscode.window.showQuickPick = pick;
      config.update = update;
    }
  });
}
