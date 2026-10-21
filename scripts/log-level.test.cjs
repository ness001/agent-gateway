// Run after build-tests: node --test scripts/log-level.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
let current, selection, workspaceValue, fail, updates, notices;
const config = {
  get: () => current,
  inspect: () => ({ workspaceValue }),
  update: async (...args) => { if (fail) throw new Error("write failed"); updates.push(args); },
};
const vscode = {
  workspace: { getConfiguration: section => { assert.equal(section, "agentGateway"); return config; } },
  window: {
    showQuickPick: async items => selection === undefined ? undefined : items.find(i => i.label === selection),
    showInformationMessage: message => notices.push(message),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};
const original = Module._load;
Module._load = function (id, ...args) { return id === "vscode" ? vscode : original.call(this, id, ...args); };
const { changeLogLevel, logLevelItems } = require("../out/commands/logLevel");
Module._load = original;
function reset() { current = "info"; selection = "debug"; workspaceValue = undefined; fail = false; updates = []; notices = []; }

test("picker lists supported levels and marks current", () => {
  const items = logLevelItems("warn");
  assert.deepEqual(items.map(i => i.label), ["error", "warn", "info", "debug"]);
  assert.deepEqual(items.filter(i => i.picked).map(i => i.label), ["warn"]);
});
for (const level of ["error", "warn", "debug"]) {
  test(`persists ${level} to user settings`, async () => {
    reset(); selection = level;
    await changeLogLevel();
    assert.deepEqual(updates, [["logLevel", level, 1]]);
    assert.equal(notices.length, 1);
  });
}
test("updates workspace override instead of an ineffective global value", async () => {
  reset(); workspaceValue = "info";
  await changeLogLevel();
  assert.deepEqual(updates, [["logLevel", "debug", 2]]);
});
for (const value of [undefined, "info"]) {
  test(`cancel or unchanged selection ${value} does not write`, async () => {
    reset(); selection = value;
    await changeLogLevel();
    assert.deepEqual(updates, []); assert.deepEqual(notices, []);
  });
}
test("failed update does not announce success", async () => {
  reset(); fail = true;
  await assert.rejects(changeLogLevel(), /write failed/);
  assert.deepEqual(notices, []);
});
