import {
  type ChildProcess,
  type SpawnOptions,
  execFile,
  spawn,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEV_TUNNEL_DOCS_URL =
  "https://learn.microsoft.com/azure/developer/dev-tunnels/get-started";
export const DEV_TUNNEL_EXPIRATION = "30d";

export type SpawnFn = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface TunnelHostExit {
  kind: "error" | "exit";
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

/** Owns only the background host; CLI installation and login remain interactive. */
export class DevTunnelHost {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly spawnHost: SpawnFn = spawn,
    private readonly onUnexpectedExit?: (exit: TunnelHostExit) => void,
    private readonly stopTimeoutMs = 2000,
  ) {}

  get active(): boolean {
    return this.child !== undefined;
  }

  start(cli: string, tunnelId: string): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Dev tunnel host has been disposed."));
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.stopping) {
      return Promise.reject(new Error("Dev tunnel host is still stopping."));
    }
    if (this.child) {
      return Promise.resolve();
    }
    const start = new Promise<void>((resolve, reject) => {
      const child = this.spawnHost(cli, ["host", tunnelId], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      this.child = child;
      let spawned = false;
      const ended = (exit: TunnelHostExit) => {
        if (this.child !== child) {
          return;
        }
        this.child = undefined;
        if (!spawned) {
          reject(new Error("Could not start the background dev tunnel host."));
        } else if (!this.stopping && !this.disposed) {
          this.onUnexpectedExit?.(exit);
        }
      };
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
      child.on("error", () => {
        if (!spawned) {
          ended({ kind: "error" });
        } else if (!this.stopping && !this.disposed) {
          this.onUnexpectedExit?.({ kind: "error" });
        }
      });
      child.once("exit", (code, signal) =>
        ended({ kind: "exit", code, signal }),
      );
    });
    this.starting = start.finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    // Queue termination so the stopping flag is set before exit/error callbacks.
    this.stopping = Promise.resolve()
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.child !== child) {
              resolve();
              return;
            }
            let forced = false;
            const finish = () => {
              clearTimeout(timer);
              child.removeListener("exit", finish);
              child.removeListener("error", onError);
              resolve();
            };
            const onError = () => {
              if (this.child !== child) {
                finish();
              }
            };
            const timer = setInterval(() => {
              if (!forced) {
                forced = true;
                child.kill("SIGKILL");
              } else {
                clearInterval(timer);
                child.removeListener("exit", finish);
                child.removeListener("error", onError);
                reject(
                  new Error("The background dev tunnel host did not stop."),
                );
              }
            }, this.stopTimeoutMs);
            timer.unref();
            child.once("exit", finish);
            child.on("error", onError);
            child.kill("SIGTERM");
          }),
      )
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }

  dispose(): void {
    this.disposed = true;
    void this.stop().catch(() => {
      this.onUnexpectedExit?.({ kind: "error" });
    });
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started at all (e.g. ENOENT). */
  spawnError?: string;
  timedOut?: boolean;
}

export type ExecFn = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecResult>;

export interface DevTunnelLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export const nodeExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const e = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
        };
        resolve({
          code: typeof e.code === "number" ? e.code : -1,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          spawnError: typeof e.code === "string" ? e.code : undefined,
          timedOut: e.killed === true,
        });
      },
    );
  });

/**
 * Errors carry the subcommand, exit code, a fixed hint and a redacted excerpt
 * of the CLI's own message so users can act without opening logs.
 */
export class DevTunnelError extends Error {
  constructor(
    readonly step: string,
    readonly exitCode: number,
    readonly hint: string,
    readonly detail?: string,
  ) {
    super(
      `devtunnel ${step} failed (exit code ${exitCode}). ${hint}${
        detail ? ` CLI said: ${detail}` : ""
      }`,
    );
  }
}

/** Redacts anything that looks like a token or JWT and trims to one short line. */
export function sanitizeCliMessage(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return undefined;
  }
  const redacted = line
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]");
  return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
}

export interface FindCliOptions {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  localAppData?: string;
  exists?: (p: string) => boolean;
}

/** Returns the CLI path/command to use, or undefined when it is not installed. */
export async function findDevTunnelCli(
  opts: FindCliOptions = {},
): Promise<string | undefined> {
  const exec = opts.exec ?? nodeExec;
  const onPath = await exec("devtunnel", ["--version"], 10_000);
  if (!onPath.spawnError && onPath.code === 0) {
    return "devtunnel";
  }
  const platform = opts.platform ?? process.platform;
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA;
  if (platform === "win32" && localAppData) {
    const candidate = path.join(
      localAppData,
      "Microsoft",
      "WinGet",
      "Links",
      "devtunnel.exe",
    );
    const exists = opts.exists ?? fs.existsSync;
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface TunnelPort {
  portNumber: number;
  portUri?: string;
}

export interface TunnelInfo {
  tunnelId: string;
  ports: TunnelPort[];
  anonymousPorts: number[] | "all" | "none";
}

export interface EnsureTunnelResult {
  tunnelId: string;
  url: string;
  urlSource: "portUri" | "derived";
  created: boolean;
  portAdded: boolean;
}

export class DevTunnelCli {
  private readonly exec: ExecFn;
  constructor(
    readonly cli: string,
    exec?: ExecFn,
    private readonly log?: DevTunnelLog,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.exec = exec ?? nodeExec;
  }

  private async run(step: string, args: string[]): Promise<ExecResult> {
    // Only the subcommand is logged; args never contain secrets but stay terse.
    this.log?.debug(`devtunnel ${step}`);
    const result = await this.exec(this.cli, args, this.timeoutMs);
    if (result.timedOut) {
      throw new DevTunnelError(
        step,
        result.code,
        `Timed out after ${Math.round(this.timeoutMs / 1000)}s; check network access to devtunnels.ms.`,
      );
    }
    if (result.spawnError) {
      throw new DevTunnelError(
        step,
        result.code,
        `Could not start the devtunnel CLI (${result.spawnError}). Reinstall it or check PATH.`,
      );
    }
    return result;
  }

  private fail(step: string, result: ExecResult, hint: string): never {
    throw new DevTunnelError(
      step,
      result.code,
      hint,
      sanitizeCliMessage(result.stderr) ?? sanitizeCliMessage(result.stdout),
    );
  }

  async isLoggedIn(): Promise<boolean> {
    const r = await this.run("user show", ["user", "show"]);
    if (r.code !== 0) {
      return false;
    }
    return !/not logged in/i.test(r.stdout + r.stderr);
  }

  /** Returns undefined when the tunnel does not exist (or is not accessible). */
  async show(tunnelId: string): Promise<TunnelInfo | undefined> {
    const r = await this.run("show", ["show", tunnelId, "--json"]);
    if (r.code !== 0) {
      if (/not found/i.test(r.stdout + r.stderr)) {
        return undefined;
      }
      this.fail("show", r, "Could not read the tunnel.");
    }
    return parseTunnelJson(r.stdout, "show", r.code);
  }

  async create(): Promise<string> {
    const r = await this.run("create", [
      "create",
      "--expiration",
      DEV_TUNNEL_EXPIRATION,
      "--json",
    ]);
    if (r.code !== 0) {
      this.fail(
        "create",
        r,
        "Sign in with 'devtunnel user login' and check your tunnel quota (devtunnel list).",
      );
    }
    return parseTunnelJson(r.stdout, "create", r.code).tunnelId;
  }

  async addPort(tunnelId: string, port: number): Promise<void> {
    const r = await this.run("port create", [
      "port",
      "create",
      tunnelId,
      "-p",
      String(port),
      "--protocol",
      "http",
    ]);
    if (r.code !== 0 && !/already exists|conflict/i.test(r.stdout + r.stderr)) {
      this.fail("port create", r, `Could not add port ${port} to the tunnel.`);
    }
  }

  async allowAnonymous(tunnelId: string, port: number): Promise<void> {
    const r = await this.run("access create", [
      "access",
      "create",
      tunnelId,
      "-p",
      String(port),
      "--anonymous",
    ]);
    if (r.code !== 0) {
      this.fail(
        "access create",
        r,
        `Could not allow anonymous access on port ${port}.`,
      );
    }
  }

  /**
   * Reuses `storedId` when it still exists, otherwise creates a persistent
   * tunnel. Ensures `port` is forwarded with anonymous connect access.
   */
  async ensureTunnel(
    storedId: string | undefined,
    port: number,
  ): Promise<EnsureTunnelResult> {
    let info = storedId ? await this.show(storedId) : undefined;
    let created = false;
    if (storedId && !info) {
      this.log?.info(
        `Stored dev tunnel ${storedId} no longer exists; creating a new one.`,
      );
    }
    if (!info) {
      const id = await this.create();
      created = true;
      info = { tunnelId: id, ports: [], anonymousPorts: "none" };
      this.log?.info(`Created dev tunnel ${id}.`);
    }
    const tunnelId = info.tunnelId;
    let portAdded = false;
    if (!info.ports.some((p) => p.portNumber === port)) {
      await this.addPort(tunnelId, port);
      portAdded = true;
      this.log?.info(`Added port ${port} to dev tunnel ${tunnelId}.`);
    }
    const anon = info.anonymousPorts;
    if (anon !== "all" && (anon === "none" || !anon.includes(port))) {
      await this.allowAnonymous(tunnelId, port);
    }
    const after = portAdded || created ? await this.show(tunnelId) : info;
    const portUri = after?.ports.find((p) => p.portNumber === port)?.portUri;
    if (portUri) {
      return {
        tunnelId,
        url: portUri.replace(/\/+$/, ""),
        urlSource: "portUri",
        created,
        portAdded,
      };
    }
    const url = deriveTunnelUrl(tunnelId, port);
    this.log?.warn(
      "devtunnel show did not report a port URI; using a derived URL (fallback, may be wrong if the service uses a different host name).",
    );
    return { tunnelId, url, urlSource: "derived", created, portAdded };
  }
}

// Accept only a tunnel ID, never an option or whitespace-separated arguments.
export const TUNNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseTunnelJson(
  stdout: string,
  step: string,
  code: number,
): TunnelInfo {
  let parsed: unknown;
  try {
    // The CLI may print banner lines before the JSON object.
    const start = stdout.indexOf("{");
    parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new DevTunnelError(
      step,
      code,
      "The CLI returned output that is not JSON; update devtunnel (winget upgrade Microsoft.devtunnel).",
    );
  }
  const tunnel = (parsed as { tunnel?: Record<string, unknown> }).tunnel;
  if (
    !tunnel ||
    typeof tunnel.tunnelId !== "string" ||
    !TUNNEL_ID_PATTERN.test(tunnel.tunnelId)
  ) {
    throw new DevTunnelError(
      step,
      code,
      "The CLI JSON has no tunnel ID; update devtunnel.",
    );
  }
  const ports: TunnelPort[] = Array.isArray(tunnel.ports)
    ? (tunnel.ports as Record<string, unknown>[])
        .filter((p) => typeof p.portNumber === "number")
        .map((p) => ({
          portNumber: p.portNumber as number,
          portUri: typeof p.portUri === "string" ? p.portUri : undefined,
        }))
    : [];
  return {
    tunnelId: tunnel.tunnelId,
    ports,
    anonymousPorts: anonymousAccess(tunnel.accessControl),
  };
}

function anonymousAccess(value: unknown): number[] | "all" | "none" {
  if (!Array.isArray(value)) {
    return "none";
  }
  // `show` lists tunnel-level entries only; port-level entries are not shown,
  // so a port-level anonymous ACE may be re-added (harmless duplicate).
  const tunnelLevel = value.some(
    (e) =>
      e &&
      typeof e === "object" &&
      (e as { type?: unknown }).type === "Anonymous" &&
      !(e as { isDeny?: unknown }).isDeny,
  );
  return tunnelLevel ? "all" : "none";
}

/**
 * Fallback when the CLI does not report a port URI. Documented form is
 * https://<id>-<port>.<region>.devtunnels.ms; some tunnels use a different
 * host label, so callers must surface that the URL was derived.
 */
export function deriveTunnelUrl(tunnelId: string, port: number): string {
  const [name, region] = tunnelId.split(".");
  return region
    ? `https://${name}-${port}.${region}.devtunnels.ms`
    : `https://${name}-${port}.devtunnels.ms`;
}

export function sanitizeHostName(hostname: string): string {
  const cleaned = hostname
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return cleaned || "remote";
}

export function clientSetupText(hostname: string, url: string): string {
  return [
    `Name: ${sanitizeHostName(hostname)}`,
    `URL: ${url}`,
    "Run 'Agent Gateway: Manage Remote Upstreams' on the client and pick 'Add remote upstream'.",
  ].join("\n");
}
