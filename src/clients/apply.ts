import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ClientPlan } from "./types";

export async function loadFiles(
  paths: string[],
): Promise<Record<string, string | undefined>> {
  const files: Record<string, string | undefined> = {};
  for (const p of paths) {
    try {
      files[p] = await fs.readFile(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      files[p] = undefined;
    }
  }
  return files;
}

export function backupStamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

export interface ApplyOptions {
  /** Defaults to now; injectable for tests. */
  now?: Date;
}

/** Writes changed files atomically; returns created backup paths. */
export async function applyPlan(
  plan: Pick<ClientPlan, "changes">,
  opts: ApplyOptions = {},
): Promise<string[]> {
  const stamp = backupStamp(opts.now ?? new Date());
  const backups: string[] = [];
  for (const change of plan.changes) {
    if (change.before === change.after) {
      continue;
    }
    const current = (await loadFiles([change.path]))[change.path];
    if (current !== change.before) {
      throw new Error(
        `${change.path} changed since the preview was computed; nothing was written for it. Run the command again.`,
      );
    }
    if (current !== undefined) {
      const backup = `${change.path}.agent-gateway-${stamp}.bak`;
      await fs.writeFile(backup, current, "utf8");
      backups.push(backup);
    }
    if (change.after === undefined) {
      await fs.rm(change.path, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(change.path), { recursive: true });
    const tmp = `${change.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, change.after, "utf8");
      await fs.rename(tmp, change.path);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
  return backups;
}

/** Replaces every occurrence of the given secrets with a marker (for previews). */
export function redactSecrets(
  text: string,
  secrets: (string | undefined)[],
): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join("<redacted>");
    }
  }
  return out;
}
