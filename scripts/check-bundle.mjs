// Loads the built bundle under plain Node with a stub 'vscode' module, so a
// bundle that cannot even be required (for example an unbundled dynamic
// require such as jsonc-parser's './impl/format') fails the test run.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(root, process.argv[2] ?? "dist/extension.cjs");

// Any property access returns another callable stub, so top-level code that
// touches vscode APIs (enums, classes, EventEmitter) still evaluates.
const stub = () =>
  new Proxy(function () {}, {
    get: (target, key) =>
      key === Symbol.toPrimitive
        ? () => ""
        : key === "prototype"
          ? target.prototype
          : key === "__esModule"
            ? false
            : stub(),
    getOwnPropertyDescriptor: (target, key) =>
      Reflect.getOwnPropertyDescriptor(target, key) ?? {
        configurable: true,
        enumerable: true,
        value: stub(),
      },
    apply: () => stub(),
    construct: () => stub(),
  });

// esbuild's __toESM copies only the module's own enumerable keys, so the stub
// must list real names. Collect every `<ns>.<Name>` the bundle reads from any
// identifier bound to require("vscode") (minified bundles rename it).
const vscodeModule = (source) => {
  const bindings = [
    ...source.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\("vscode"\)/g,
    ),
  ].map(([, name]) => name.replace(/[$]/g, "\\$"));
  const names = new Set();
  for (const binding of bindings) {
    for (const [, name] of source.matchAll(
      new RegExp(`\\b${binding}\\.([A-Za-z_$][\\w$]*)`, "g"),
    )) {
      names.add(name);
    }
  }
  return Object.fromEntries([...names].map((name) => [name, stub()]));
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return vscodeModule(readFileSync(bundle, "utf8"));
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const loaded = createRequire(import.meta.url)(bundle);
  if (typeof loaded.activate !== "function") {
    throw new Error("bundle does not export activate()");
  }
  console.log(`Bundle loads: ${bundle}`);
} catch (error) {
  console.error(`Bundle failed to load: ${bundle}`);
  console.error(error);
  process.exit(1);
} finally {
  Module._load = originalLoad;
}
