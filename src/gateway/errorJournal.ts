import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Metadata-only record of a failed request. Never holds prompts, bodies,
 * tool arguments, provider messages or credentials.
 */
export interface ErrorRecord {
  time: string;
  requestId: string;
  protocol: string;
  method: string;
  path: string;
  status: number;
  model?: string;
  kind?: string;
  providerCode?: string;
  remote?: string;
  elapsedMs: number;
}

export const RECENT_ERROR_LIMIT = 20;
export const ERROR_LOG_RETENTION_DAYS = 7;
const FILE_PREFIX = "errors-";
const FILE_SUFFIX = ".jsonl";

const fileDate = (iso: string): string => iso.slice(0, 10);

/**
 * Keeps the last few failures in memory for /health and appends every failure
 * to a daily JSON-lines file (one line per request) when a directory is set.
 */
export class ErrorJournal {
  private readonly recent: ErrorRecord[] = [];
  private readonly counts = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();
  private lastPruneDate: string | undefined;

  constructor(
    private readonly directory: string | undefined,
    private readonly retentionDays = ERROR_LOG_RETENTION_DAYS,
  ) {}

  record(entry: ErrorRecord): void {
    this.recent.push(entry);
    if (this.recent.length > RECENT_ERROR_LIMIT) {
      this.recent.shift();
    }
    const key = `${entry.status} ${entry.kind ?? "http"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (this.directory) {
      const dir = this.directory;
      // Serialise appends; a logging failure must never affect a request.
      this.writeChain = this.writeChain
        .then(() => this.append(dir, entry))
        .catch(() => undefined);
    }
  }

  recentErrors(): ErrorRecord[] {
    return [...this.recent].reverse();
  }

  countsByKind(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** Resolves when pending file writes finish (used by tests and shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  get logDirectory(): string | undefined {
    return this.directory;
  }

  private async append(dir: string, entry: ErrorRecord): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const day = fileDate(entry.time);
    await fs.appendFile(
      path.join(dir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
    if (this.lastPruneDate !== day) {
      this.lastPruneDate = day;
      await pruneErrorLogs(dir, this.retentionDays, new Date(entry.time));
    }
  }
}

/** Deletes daily error files older than the retention window. */
export async function pruneErrorLogs(
  dir: string,
  retentionDays: number,
  now: Date,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const removed: string[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
      continue;
    }
    const day = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
      await fs.rm(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
