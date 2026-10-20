// Startup probe, run in a fresh Node process by startup.perf.test.ts:
//   node startup.cjs <bundle> <port>
// Loads the bundle with a stub `vscode` (fake LM API with two models, the
// port from the argument), calls activate() and polls GET /health until it
// answers 200. Prints {"requireMs": n, "activateToHealthMs": n}.
const fs = require("node:fs");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");

const [bundle, port] = [process.argv[2], Number(process.argv[3])];

// Any property access returns another callable stub, so code that touches
// vscode APIs the probe does not care about still evaluates.
const stub = () =>
  new Proxy(function () {}, {
    get: (target, key) =>
      key === Symbol.toPrimitive
        ? () => ""
        : key === "prototype"
          ? target.prototype
          : key === "then"
            ? undefined
            : stub(),
    apply: () => stub(),
    construct: () => stub(),
  });

class EventEmitter {
  listeners = [];
  event = (fn) => {
    this.listeners.push(fn);
    return { dispose() {} };
  };
  fire(value) {
    for (const fn of this.listeners) {
      fn(value);
    }
  }
  dispose() {}
}
const disposable = () => ({ dispose() {} });
const model = (id) => ({
  id,
  name: id,
  vendor: "copilot",
  family: id,
  version: "1",
  maxInputTokens: 200000,
  capabilities: { supportsToolCalling: true },
  countTokens: async () => 1,
  sendRequest: async () => ({ stream: (async function* () {})() }),
});
const settings = { port };
const real = {
  version: "1.140.0",
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  window: {
    createOutputChannel: () => ({
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      clear() {},
      show() {},
      hide() {},
      dispose() {},
    }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  },
  commands: { registerCommand: disposable, executeCommand: async () => {} },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => settings[key] ?? fallback,
    }),
    onDidChangeConfiguration: disposable,
  },
  extensions: { getExtension: () => undefined },
  lm: {
    selectChatModels: async () => [model("perf-a"), model("perf-b")],
    onDidChangeChatModels: disposable,
  },
};

// esbuild's __toESM copies only own enumerable keys, so list every name the
// bundle reads from require("vscode") (same scan as scripts/check-bundle.mjs).
const source = fs.readFileSync(bundle, "utf8");
const names = new Set(Object.keys(real));
for (const [, binding] of source.matchAll(
  /\b([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\("vscode"\)/g,
)) {
  const escaped = binding.replace(/[$]/g, "\\$");
  for (const [, name] of source.matchAll(
    new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)`, "g"),
  )) {
    names.add(name);
  }
}
const vscode = Object.fromEntries(
  [...names].map((name) => [name, real[name] ?? stub()]),
);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === "vscode"
    ? vscode
    : originalLoad.call(this, request, parent, isMain);
};

const context = {
  subscriptions: [],
  secrets: {
    get: async () => undefined,
    store: async () => {},
    onDidChange: disposable,
  },
  globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
  extension: { packageJSON: { version: "0.0.0-perf" } },
  logUri: undefined,
};

async function main() {
  const t0 = performance.now();
  const ext = require(bundle);
  const t1 = performance.now();
  ext.activate(context);
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (performance.now() - t1 > 10000) {
      throw new Error("no /health answer in 10 s");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  const t2 = performance.now();
  await ext.deactivate?.();
  process.stdout.write(
    JSON.stringify({ requireMs: t1 - t0, activateToHealthMs: t2 - t1 }),
  );
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
