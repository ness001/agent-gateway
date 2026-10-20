#!/usr/bin/env node
// Client contract check: runs each installed coding agent once through a
// recording proxy in front of the gateway and compares the redacted request
// shape with the committed snapshot, so a client release that changes what it
// sends (new tool types, input items, headers, endpoints) is noticed early.
//
//   node test-live/contracts/check.mjs [--target http://127.0.0.1:24444] [--only a,b] [--update] [--timeout 300]
//
// Requires `pnpm run build-tests` (client configs come from out/clients).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUGGY,
  CLIENTS,
  isFixed,
  killAll,
  runClient,
  versionOf,
} from "./clients.mjs";
import { startProxy } from "./record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const SNAPSHOTS = path.join(HERE, "snapshots");

function parseArgs(argv) {
  const out = { target: "http://127.0.0.1:24444", timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i].replace(/\/+$/, "");
    else if (a === "--only")
      out.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--update") out.update = true;
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    `usage: check.mjs [--target URL] [--only ${Object.keys(CLIENTS).join(",")}] [--update] [--timeout SECONDS]`,
  );
  process.exit(0);
}
const ids = args.only ?? Object.keys(CLIENTS);
for (const id of ids)
  if (!CLIENTS[id]) throw new Error(`Unknown client: ${id}`);

// Adapters honour these overrides; unset them so planned files land in the
// throwaway home, never in a real config directory.
for (const k of [
  "DSH_HOME",
  "HERMES_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "CODEX_HOME",
])
  delete process.env[k];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ag-contracts-"));
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    killAll();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(130);
  });

async function gatewayModels() {
  const res = await fetch(`${args.target}/v1/models`);
  if (!res.ok)
    throw new Error(`${args.target}/v1/models returned ${res.status}`);
  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    displayName: m.display_name ?? m.id,
    contextWindow: m.context_window ?? null,
    inputModalities: ["text"],
    supportsToolCalling: true,
    reasoning: false,
  }));
}

/** Removes per-run noise (model ids picked by the client's own heuristics stay). */
function snapshotOf(id, version, result, shape) {
  return {
    client: id,
    version,
    result: {
      status: result.status,
      exit: result.exit,
      fixed: result.fixed,
    },
    endpoints: shape,
  };
}

function diffSnapshots(prev, next) {
  const lines = [];
  if (prev.version !== next.version)
    lines.push(`version ${prev.version} -> ${next.version}`);
  for (const k of ["status", "exit", "fixed"])
    if (prev.result?.[k] !== next.result?.[k])
      lines.push(`result.${k} ${prev.result?.[k]} -> ${next.result?.[k]}`);
  const a = prev.endpoints ?? {};
  const b = next.endpoints ?? {};
  for (const ep of Object.keys(b))
    if (!(ep in a)) lines.push(`new endpoint ${ep}`);
  for (const ep of Object.keys(a))
    if (!(ep in b)) lines.push(`endpoint no longer used ${ep}`);
  for (const ep of Object.keys(b)) {
    if (!(ep in a)) continue;
    const fields = new Set([...Object.keys(a[ep]), ...Object.keys(b[ep])]);
    for (const f of [...fields].sort()) {
      const before = new Set(a[ep][f] ?? []);
      const after = new Set(b[ep][f] ?? []);
      for (const v of after)
        if (!before.has(v)) lines.push(`${ep}: new ${f} value \`${v}\``);
      for (const v of before)
        if (!after.has(v)) lines.push(`${ep}: ${f} value \`${v}\` gone`);
    }
  }
  return lines;
}

/** Failed model calls. GET probes (Hermes looks for local servers) may 404 by design. */
function nonOk(shape) {
  const bad = [];
  for (const [ep, e] of Object.entries(shape))
    if (ep.startsWith("POST "))
      for (const s of e.status ?? [])
        if (!/^2\d\d$/.test(s)) bad.push(`${ep} -> ${s}`);
  return bad;
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SNAPSHOTS, { recursive: true });
const models = await gatewayModels();
const rows = [];
let failed = false;

for (const id of ids) {
  const client = CLIENTS[id];
  const exe = client.exe();
  if (!exe) {
    rows.push({ id, version: "-", status: "skipped: not installed" });
    continue;
  }
  const version = versionOf(exe);
  const base = path.join(scratch, id);
  const dir = path.join(base, "work");
  const home = path.join(base, "home");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, "m.py"), BUGGY);

  const proxy = await startProxy({ target: args.target });
  process.stdout.write(`${id} ${version} ... `);
  let r;
  try {
    r = await runClient(id, {
      proxyUrl: proxy.url,
      dir,
      home,
      models,
      timeoutMs: args.timeout * 1000,
    });
  } finally {
    await proxy.close();
  }
  const shape = proxy.recorder.shape();
  const result = {
    status: r.timedOut ? "timeout" : r.code === 0 ? "ok" : "failed",
    exit: r.timedOut ? null : r.code,
    fixed: isFixed(dir),
  };
  console.log(`${result.status}, fixed=${result.fixed}`);
  if (result.status !== "ok")
    console.log(
      `  output tail:\n${(r.stdout + r.stderr)
        .trim()
        .split(/\r?\n/)
        .slice(-15)
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );

  const snap = snapshotOf(id, version, result, shape);
  const text = JSON.stringify(snap, null, 2) + "\n";
  fs.writeFileSync(path.join(OUT, `${id}.json`), text);

  const snapPath = path.join(SNAPSHOTS, `${id}.json`);
  let changes = [];
  if (args.update) {
    fs.writeFileSync(snapPath, text);
  } else if (fs.existsSync(snapPath)) {
    changes = diffSnapshots(
      JSON.parse(fs.readFileSync(snapPath, "utf8")),
      snap,
    );
  } else {
    changes = ["no snapshot (run with --update)"];
  }
  const errors = nonOk(shape);
  if (result.status !== "ok")
    errors.push(`client ${result.status} (exit ${result.exit})`);
  if (!result.fixed) errors.push("m.py not fixed");
  if (changes.length || errors.length) failed = true;
  rows.push({
    id,
    version,
    status: result.status,
    fixed: result.fixed,
    changes,
    errors,
  });
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log(
  "\nclient            version              status   fixed  contract",
);
for (const r of rows) {
  const contract =
    r.changes === undefined
      ? ""
      : r.changes.length
        ? `${r.changes.length} change(s)`
        : args.update
          ? "snapshot updated"
          : "unchanged";
  console.log(
    `${r.id.padEnd(18)}${String(r.version).padEnd(21)}${String(r.status).padEnd(9)}${String(r.fixed ?? "-").padEnd(7)}${contract}`,
  );
  for (const c of r.changes ?? []) console.log(`  ${r.id}: ${c}`);
  for (const e of r.errors ?? []) console.log(`  ${r.id}: ERROR ${e}`);
}
process.exit(failed ? 1 : 0);
