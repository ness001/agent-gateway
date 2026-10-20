#!/usr/bin/env node
// Client version watch: compares the client version recorded in each
// contract snapshot (and the installed CLI, when present) with the latest
// published release (npm, pip, or GitHub releases via `gh`). npm calls pass --registry explicitly: NPM_REGISTRY, else
// `npm config get registry`; pip uses its configured index.
//
//   node test-live/contracts/versions.mjs [--json] [--no-installed]
//
// Exit code 0 always; the "newer" list in --json output (and the NEWER marker
// in the table) tells a scheduled job that the contract check should be rerun.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENTS, versionOf } from "./clients.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const checkInstalled = !argv.includes("--no-installed");

function sh(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 120000,
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * Registry passed explicitly to every npm call: NPM_REGISTRY when set, else
 * whatever npm is configured with. Never hard-coded.
 */
const REGISTRY =
  process.env.NPM_REGISTRY || sh("npm", ["config", "get", "registry"]);

/** Platform builds and nightlies are published under the same package. */
const NOT_A_RELEASE = /(nightly|preview|darwin|linux|win32|-x64|-arm64)/i;

function highest(versions, allowPre) {
  return versions
    .filter((v) => !NOT_A_RELEASE.test(v) && (allowPre || !v.includes("-")))
    .reduce(
      (best, v) => (best === undefined || newer(v, best) ? v : best),
      undefined,
    );
}

/** Highest published release; pre-releases count when the snapshot is one. */
function latest(client, current) {
  const allowPre = Boolean(current?.includes("-"));
  if (client.npm) {
    const out = sh("npm", [
      "view",
      client.npm,
      "versions",
      "--json",
      ...(REGISTRY ? ["--registry", REGISTRY] : []),
    ]);
    try {
      const list = JSON.parse(out);
      return highest(Array.isArray(list) ? list : [list], allowPre);
    } catch {
      return undefined;
    }
  }
  if (client.pip) {
    for (const py of ["python", "python3"]) {
      const out = sh(py, ["-m", "pip", "index", "versions", client.pip]);
      const m = out?.match(/Available versions:\s*(.+)/);
      if (m) return highest(m[1].split(/,\s*/), allowPre);
    }
  }
  if (client.github) {
    const out = sh("gh", [
      "api",
      `repos/${client.github}/releases`,
      "--jq",
      ".[].tag_name",
    ]);
    if (out)
      return highest(
        out.split(/\s+/).map((t) => t.replace(/^v/, "")),
        allowPre,
      );
  }
  return undefined;
}

function snapshotVersion(id) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(HERE, "snapshots", `${id}.json`), "utf8"),
    ).version;
  } catch {
    return undefined;
  }
}

/** True when version a is newer than b (semver-ish, numeric pre-release parts). */
function newer(a, b) {
  if (!a || !b) return false;
  const [ca, ...ra] = a.split("-");
  const [cb, ...rb] = b.split("-");
  const pa = ca.split(".").map(Number);
  const pb = cb.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  if (!ra.length || !rb.length) return !ra.length && rb.length > 0;
  const xa = ra.join("-").split(".");
  const xb = rb.join("-").split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === xb[i]) continue;
    if (xa[i] === undefined) return false;
    if (xb[i] === undefined) return true;
    const na = Number(xa[i]);
    const nb = Number(xb[i]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
    return xa[i] > xb[i];
  }
  return false;
}

const rows = [];
for (const [id, client] of Object.entries(CLIENTS)) {
  const exe = checkInstalled ? client.exe() : undefined;
  const row = {
    client: id,
    package:
      client.npm ??
      (client.pip ? `pip:${client.pip}` : `github:${client.github}`),
    snapshot: snapshotVersion(id) ?? null,
    installed: exe ? versionOf(exe) : null,
    latest: null,
  };
  row.latest = latest(client, row.snapshot ?? row.installed) ?? null;
  row.newer = newer(row.latest, row.snapshot);
  rows.push(row);
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        clients: rows,
        newer: rows.filter((r) => r.newer).map((r) => r.client),
      },
      null,
      2,
    ),
  );
} else {
  const cols = ["client", "package", "snapshot", "installed", "latest"];
  const w = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "-").length)),
  );
  const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join("  ");
  console.log(line(cols));
  for (const r of rows)
    console.log(
      line(cols.map((c) => r[c] ?? "-")) + (r.newer ? "  NEWER" : ""),
    );
}
