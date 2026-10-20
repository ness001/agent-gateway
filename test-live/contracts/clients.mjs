// How to run each coding agent once, non-interactively, against a gateway URL.
// Client configs are generated with the extension's own adapters
// (out/clients, built by `pnpm run build-tests`) into a throwaway home
// directory, and each client is pointed at it with an env var or flag, so
// the user's real configuration is never read or written.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);

export const PROMPT =
  "The function add in ./m.py should return the sum of a and b but it has a bug. " +
  "Fix ./m.py by editing the file, then reply with one short sentence.";
export const BUGGY = "def add(a, b):\n    return a - b\n";

/** True when m.py now adds. */
export function isFixed(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "m.py"), "utf8");
    return /return\s+a\s*\+\s*b|return\s+b\s*\+\s*a/.test(text);
  } catch {
    return false;
  }
}

function loadAdapters() {
  const index = path.join(REPO, "out", "clients", "index.js");
  if (!fs.existsSync(index))
    throw new Error("out/clients is missing; run `pnpm run build-tests` first");
  const { ALL_CLIENT_ADAPTERS } = require(index);
  return Object.fromEntries(ALL_CLIENT_ADAPTERS.map((a) => [a.id, a]));
}

/** Writes the adapter's planned files under `home`; returns their paths. */
function writePlan(adapterId, { proxyUrl, home, models, defaultModel }) {
  const adapter = loadAdapters()[adapterId];
  const plan = adapter.plan(
    {
      gatewayUrl: proxyUrl,
      models,
      defaultModel,
      home,
      platform: process.platform,
    },
    {},
  );
  const written = [];
  for (const c of plan.changes) {
    if (c.after === undefined) continue;
    fs.mkdirSync(path.dirname(c.path), { recursive: true });
    fs.writeFileSync(c.path, c.after);
    written.push(c.path);
  }
  return written;
}

/** Locates an executable on PATH (plus `extraDirs`); undefined when absent. */
export function which(name, extraDirs = []) {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")]
      : [""];
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    ...extraDirs,
  ].filter(Boolean);
  for (const d of dirs)
    for (const e of exts) {
      const p = path.join(d, name + e.toLowerCase());
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  return undefined;
}

/**
 * The native Codex binary inside a global `@openai/codex` npm install
 * (`<npm root -g>/@openai/codex/vendor/<target>/bin/codex[.exe]`), for
 * machines where only the npm package is installed and `codex` is not on PATH.
 */
function codexNativeFromNpm() {
  const r = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const root = r.status === 0 ? r.stdout.trim() : "";
  const vendor = root && path.join(root, "@openai", "codex", "vendor");
  if (!vendor || !fs.existsSync(vendor)) return undefined;
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  for (const target of fs.readdirSync(vendor)) {
    const p = path.join(vendor, target, "bin", name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function pythonUserScripts() {
  for (const py of ["python", "python3"]) {
    const r = spawnSync(
      py,
      [
        "-c",
        `import sysconfig;print(sysconfig.get_path('scripts','${process.platform === "win32" ? "nt_user" : "posix_user"}'))`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status === 0 && r.stdout.trim()) return [r.stdout.trim()];
  }
  return [];
}

/** Quotes one argument for a shell command line. */
function q(arg) {
  if (/^[\w./:=\\@,-]+$/.test(arg)) return arg;
  if (process.platform === "win32") {
    if (arg.includes('"'))
      throw new Error(`argument may not contain '"': ${arg}`);
    return `"${arg}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const liveChildren = new Set();

export function killAll() {
  for (const c of liveChildren) killTree(c);
}

function killTree(child) {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else child.kill("SIGKILL");
}

/** Runs a command with stdin closed. Resolves { code, stdout, stderr, timedOut }. */
export function run(cmd, args, { cwd, env, timeoutMs = 300000 }) {
  // npm shims (.cmd) cannot be spawned directly on Windows.
  const shell = process.platform === "win32" && !/\.exe$/i.test(cmd);
  return new Promise((resolve) => {
    const child = shell
      ? spawn([q(cmd), ...args.map(q)].join(" "), {
          cwd,
          env,
          shell: true,
          windowsHide: true,
        })
      : spawn(cmd, args, { cwd, env, windowsHide: true });
    child.stdin.end();
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (err) => (stderr += String(err)));
    child.on("close", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Environment without the caller's provider credentials. */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ])
    if (!(k in (extra || {}))) delete env[k];
  return env;
}

/** First non-empty line of `<exe> --version`, without a leading product name. */
export function versionOf(exe, args = ["--version"]) {
  const shell = process.platform === "win32" && !/\.exe$/i.test(exe);
  // Some CLIs (Gemini) occasionally print nothing on a cold start; retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync(shell ? q(exe) : exe, args, {
      encoding: "utf8",
      shell,
      windowsHide: true,
      timeout: 60000,
    });
    const text = `${r.stdout || ""}
${r.stderr || ""}`;
    const m = text.match(/\d+\.\d+\.\d+(?:[-.+][\w.]+)?/);
    if (m) return m[0];
  }
  return "unknown";
}

/**
 * Client table. Each entry:
 *   exe(): executable path or undefined when not installed
 *   npm / pip / github: package name or owner/repo for versions.mjs
 *   prepare(ctx): writes temporary config, returns { args, env }
 * ctx = { proxyUrl, dir (task dir), home (throwaway home), models }
 */
export const CLIENTS = {
  "claude-code": {
    npm: "@anthropic-ai/claude-code",
    exe: () => which("claude"),
    model: "claude-haiku-5.5",
    prepare(ctx) {
      const [settings] = writePlan("claude-code", {
        ...ctx,
        proxyUrl: ctx.proxyUrl,
        defaultModel: this.model,
      });
      return {
        args: [
          "-p",
          PROMPT,
          "--settings",
          settings,
          "--model",
          this.model,
          "--dangerously-skip-permissions",
        ],
        env: {
          ANTHROPIC_BASE_URL: ctx.proxyUrl,
          ANTHROPIC_AUTH_TOKEN: "contracts",
        },
      };
    },
  },

  codex: {
    npm: "@openai/codex",
    // The native binary; the npm `codex` shim needs a shell on Windows.
    exe: () => process.env.CODEX_EXE || which("codex") || codexNativeFromNpm(),
    model: "gpt-5.6-sol",
    prepare(ctx) {
      writePlan("codex", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "exec",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          // A user PowerShell profile could change directory under a login shell.
          "-c",
          "allow_login_shell=false",
          "-m",
          this.model,
          "-C",
          ctx.dir,
          PROMPT,
        ],
        env: { CODEX_HOME: path.join(ctx.home, ".codex") },
      };
    },
  },

  "gemini-cli": {
    npm: "@google/gemini-cli",
    exe: () => which("gemini"),
    model: "gemini-3.8-flash",
    prepare(ctx) {
      // No adapter: Gemini CLI is configured by env. GEMINI_CLI_HOME moves
      // ~/.gemini so the API-key auth type can be selected without touching
      // the user's settings.
      const settings = path.join(ctx.home, ".gemini", "settings.json");
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(
        settings,
        JSON.stringify({
          security: { auth: { selectedType: "gemini-api-key" } },
        }),
      );
      return {
        args: ["-p", PROMPT, "-m", this.model, "--yolo"],
        env: {
          GEMINI_CLI_HOME: ctx.home,
          GOOGLE_GEMINI_BASE_URL: ctx.proxyUrl,
          GEMINI_API_KEY: "contracts",
        },
      };
    },
  },

  antigravity: {
    github: "google-antigravity/antigravity-cli",
    // The install script adds `agy`; the release zip ships antigravity.exe.
    // AGY_EXE points at either when it is not on PATH.
    exe: () => process.env.AGY_EXE || which("agy") || which("antigravity"),
    model: "gemini-3.8-flash",
    prepare(ctx) {
      // agy has no config-dir override; it reads ~/.gemini/antigravity-cli
      // from the home directory, so the throwaway home replaces it.
      writePlan("antigravity", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "-p",
          PROMPT,
          "--model",
          this.model,
          "--dangerously-skip-permissions",
          "--print-timeout",
          "240s",
        ],
        env: {
          HOME: ctx.home,
          USERPROFILE: ctx.home,
          GOOGLE_GEMINI_BASE_URL: ctx.proxyUrl,
          GEMINI_API_KEY: "contracts",
        },
      };
    },
  },

  pi: {
    npm: "@mariozechner/pi-coding-agent",
    exe: () => which("pi"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      writePlan("pi", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "-p",
          "--provider",
          "agent-gateway",
          "--model",
          this.model,
          PROMPT,
        ],
        env: { PI_CODING_AGENT_DIR: path.join(ctx.home, ".pi", "agent") },
      };
    },
  },

  omp: {
    npm: "@oh-my-pi/pi-coding-agent",
    exe: () => which("omp"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      writePlan("omp", { ...ctx, defaultModel: this.model });
      return {
        args: ["-p", "--model", `agent-gateway/${this.model}`, PROMPT],
        env: { PI_CODING_AGENT_DIR: path.join(ctx.home, ".omp", "agent") },
      };
    },
  },

  hermes: {
    pip: "hermes-agent",
    exe: () => which("hermes", pythonUserScripts()),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      const [config] = writePlan("hermes", {
        ...ctx,
        defaultModel: this.model,
      });
      return {
        args: [
          "--provider",
          "agent-gateway",
          "-m",
          this.model,
          "--yolo",
          "-z",
          PROMPT,
        ],
        env: { HERMES_HOME: path.dirname(config) },
      };
    },
  },

  kilo: {
    npm: "@kilocode/cli",
    exe: () => which("kilo"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      const [config] = writePlan("kilo", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "run",
          "--auto",
          "--dir",
          ctx.dir,
          "-m",
          `agent-gateway/${this.model}`,
          PROMPT,
        ],
        env: { KILO_CONFIG: config },
      };
    },
  },

  cline: {
    npm: "cline",
    exe: () => which("cline"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      writePlan("cline", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "--config",
          path.join(ctx.home, ".cline"),
          "-y",
          "-t",
          "240",
          "-P",
          "openai-compatible",
          "-m",
          this.model,
          PROMPT,
        ],
        env: {},
      };
    },
  },

  "deepseek-harness": {
    npm: "@deepseek-ai/dsh",
    exe: () => which("dsh"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      const dshHome = path.join(ctx.home, ".dsh");
      writePlan("deepseek-harness", {
        ...ctx,
        defaultModel: this.model,
      });
      return { args: ["headless", PROMPT], env: { DSH_HOME: dshHome } };
    },
  },

  openclaw: {
    npm: "openclaw",
    exe: () => which("openclaw"),
    model: "claude-sonnet-5.5",
    prepare(ctx) {
      const state = path.join(ctx.home, ".openclaw");
      writePlan("openclaw", { ...ctx, defaultModel: this.model });
      return {
        args: [
          "agent",
          "--local",
          "--model",
          `agent-gateway/${this.model}`,
          "--message",
          PROMPT,
        ],
        env: { OPENCLAW_STATE_DIR: state },
      };
    },
  },
};

/** Runs one client in `dir` with a throwaway `home`. */
export async function runClient(id, ctx) {
  const client = CLIENTS[id];
  const exe = client.exe();
  const { args, env } = client.prepare(ctx);
  return run(exe, args, {
    cwd: ctx.dir,
    env: cleanEnv(env),
    timeoutMs: ctx.timeoutMs,
  });
}
