// Bundle budget: reports dist/extension.cjs size and what contributes to it,
// using the esbuild metafile in dist/meta.json. Report mode always exits 0;
// --strict exits 1 when the bundle exceeds the size budget.
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUDGET_BYTES = 450 * 1024;

/** Maps an esbuild input path to its top-level package ("(app)" for own code). */
export function packageOf(input) {
  const p = input.split(String.fromCharCode(92)).join("/");
  const i = p.lastIndexOf("node_modules/");
  if (i < 0) return "(app)";
  const parts = p.slice(i + "node_modules/".length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Summarises bytes in the output per input and per package. */
export function summarize(meta, outFile = "dist/extension.cjs") {
  const out = meta.outputs[outFile] ?? Object.values(meta.outputs)[0];
  const inputs = Object.entries(out?.inputs ?? {}).map(([path, v]) => ({
    path,
    bytes: v.bytesInOutput,
  }));
  inputs.sort((a, b) => b.bytes - a.bytes);
  const pkgs = new Map();
  for (const i of inputs)
    pkgs.set(packageOf(i.path), (pkgs.get(packageOf(i.path)) ?? 0) + i.bytes);
  const packages = [...pkgs].map(([name, bytes]) => ({ name, bytes }));
  packages.sort((a, b) => b.bytes - a.bytes);
  return { inputs, packages };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const strict = process.argv.includes("--strict");
  const total = statSync(resolve(root, "dist/extension.cjs")).size;
  const meta = JSON.parse(
    readFileSync(resolve(root, "dist/meta.json"), "utf8"),
  );
  const { inputs, packages } = summarize(meta);
  console.log(
    `[bundle-budget] dist/extension.cjs ${kb(total)} (budget ${kb(BUDGET_BYTES)})`,
  );
  console.log("  top inputs:");
  for (const i of inputs.slice(0, 15))
    console.log(`    ${kb(i.bytes).padStart(10)}  ${i.path}`);
  console.log("  by package:");
  for (const p of packages)
    console.log(`    ${kb(p.bytes).padStart(10)}  ${p.name}`);
  if (total > BUDGET_BYTES) {
    console.log(`  over budget by ${kb(total - BUDGET_BYTES)}`);
    if (strict) process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
