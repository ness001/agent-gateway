#!/usr/bin/env node
// Automated soak suite: drives the real Claude Code, Codex and Gemini CLIs
// against a running gateway in throwaway scratch repositories.
//
//   node test-live/soak/soak.mjs --base http://127.0.0.1:24445 [--only <scenario>[,<scenario>]] [--label <name>]
//
// User configuration is never modified, with one exception: Gemini CLI only
// honours GEMINI_API_KEY when ~/.gemini/settings.json selects the API-key
// auth type, so that file is backed up, patched and always restored.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The native Codex binary (the npm `codex` shim needs a shell on Windows).
const CODEX_EXE = process.env.CODEX_EXE || "codex";
const MODELS = {
  claude: "claude-haiku-5.5",
  claudeLong: "claude-sonnet-5.5",
  codex: "gpt-5.4-mini",
  gemini: "gemini-3.8-flash",
};

// ---------- arguments ----------

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:24445",
    only: undefined,
    label: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--only")
      out.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.base = out.base.replace(/\/+$/, "");
  return out;
}

// ---------- process helpers ----------

/** Quotes one argument for cmd.exe (prompts must not contain double quotes). */
function q(arg) {
  if (/^[\w./:=\\-]+$/.test(arg)) return arg;
  if (arg.includes('"'))
    throw new Error(`argument may not contain '"': ${arg}`);
  return `"${arg}"`;
}

function killTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGKILL");
  }
}

const liveChildren = new Set();

/**
 * Runs a command. `shell` is needed for npm .cmd shims (claude, gemini).
 * Resolves with { code, stdout, stderr, timedOut, killed, ms }.
 */
function run(
  cmd,
  args,
  { cwd, env, timeoutMs, shell = false, killAfterMs, onStart },
) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = shell
      ? spawn([cmd, ...args.map(q)].join(" "), {
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
    let killed = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    let killTimer;
    if (killAfterMs !== undefined) {
      killTimer = setTimeout(() => {
        killed = true;
        killTree(child);
      }, killAfterMs);
    }
    onStart?.(child, () => {
      killed = true;
      killTree(child);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      liveChildren.delete(child);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        killed,
        ms: Date.now() - started,
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- gateway observation ----------

async function health(base) {
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error(`/health returned ${res.status}`);
  return res.json();
}

/** Newest "Agent Gateway.log" for the dev extension (VS Code output channel file). */
function findGatewayLog() {
  const roots = ["Code", "Code - Insiders"].map((n) =>
    path.join(process.env.APPDATA ?? "", n, "logs"),
  );
  let best;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const session of fs.readdirSync(root)) {
      const sdir = path.join(root, session);
      let windows = [];
      try {
        windows = fs.readdirSync(sdir).filter((w) => w.startsWith("window"));
      } catch {
        continue;
      }
      for (const w of windows) {
        const file = path.join(
          sdir,
          w,
          "exthost",
          "ness001.agent-gateway-dev",
          "Agent Gateway.log",
        );
        if (!fs.existsSync(file)) continue;
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      }
    }
  }
  return best?.file;
}

/** Gateway log lines whose local timestamp falls at or after `sinceMs`. */
function logLinesSince(sinceMs) {
  const file = findGatewayLog();
  if (!file) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(line);
    if (!m) continue;
    const t = new Date(`${m[1]}T${m[2]}`).getTime(); // local time
    if (t >= sinceMs - 1000) out.push(line);
  }
  return out;
}

/** Journal errors recorded since `sinceMs`, minus those `allow` accepts. */
async function journalErrorsSince(base, sinceMs, allow = () => false) {
  const h = await health(base);
  const recent = h.errors?.recent ?? [];
  return recent.filter(
    (e) => new Date(e.time).getTime() >= sinceMs - 1000 && !allow(e),
  );
}

// ---------- fixtures ----------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A solid-colour RGB PNG, generated so no binary fixture is checked in. */
function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(size).fill([r, g, b]).flat()),
  ]);
  const raw = Buffer.concat(Array(size).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function gitInit(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=soak@local", "-c", "user.name=soak", "add", "-A"],
    { cwd: dir },
  );
  spawnSync(
    "git",
    [
      "-c",
      "user.email=soak@local",
      "-c",
      "user.name=soak",
      "commit",
      "-qm",
      "init",
      "--allow-empty",
    ],
    { cwd: dir },
  );
}

/** Runs a node snippet in `dir`; returns trimmed stdout or throws. */
function nodeEval(dir, code) {
  const r = spawnSync(process.execPath, ["-e", code], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20000,
  });
  if (r.status !== 0)
    throw new Error(
      `node check failed: ${(r.stderr || r.stdout).slice(0, 300)}`,
    );
  return r.stdout.trim();
}

// ---------- client wrappers ----------

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"])
    delete env[k];
  return env;
}

function claude(
  ctx,
  dir,
  prompt,
  { extraArgs = [], model = MODELS.claude, timeoutMs = 240000, ...rest } = {},
) {
  const settings = path.join(
    dir,
    "..",
    `${path.basename(dir)}.claude-settings.json`,
  );
  fs.writeFileSync(
    settings,
    JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: ctx.base, ANTHROPIC_AUTH_TOKEN: "soak" } },
      null,
      2,
    ),
  );
  const args = [
    "-p",
    prompt,
    "--settings",
    settings,
    "--model",
    model,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    ...extraArgs,
  ];
  return run("claude", args, {
    cwd: dir,
    shell: true,
    timeoutMs,
    env: cleanEnv({
      ANTHROPIC_BASE_URL: ctx.base,
      ANTHROPIC_AUTH_TOKEN: "soak",
    }),
    ...rest,
  });
}

function codexArgs(ctx, model, extra) {
  const c = (kv) => ["-c", kv];
  return [
    // Codex runs shell tools as a login shell; a user PowerShell profile that
    // changes directory would then write files outside the scratch repo.
    ...c("allow_login_shell=false"),
    ...c('model_provider="soak"'),
    ...c('model_providers.soak.name="soak"'),
    ...c(`model_providers.soak.base_url="${ctx.base}/v1"`),
    ...c('model_providers.soak.wire_api="responses"'),
    ...c('model_providers.soak.env_key="SOAK_GATEWAY_KEY"'),
    "-m",
    model,
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    ...extra,
  ];
}

function codex(
  ctx,
  dir,
  prompt,
  { resume = false, extra = [], model = MODELS.codex, timeoutMs = 300000 } = {},
) {
  const args = resume
    ? ["exec", "resume", "--last", ...codexArgs(ctx, model, extra), prompt]
    : ["exec", ...codexArgs(ctx, model, extra), "-C", dir, prompt];
  return run(CODEX_EXE, args, {
    cwd: dir,
    timeoutMs,
    env: cleanEnv({ SOAK_GATEWAY_KEY: "soak" }),
  });
}

function gemini(
  ctx,
  dir,
  prompt,
  { model = MODELS.gemini, timeoutMs = 240000 } = {},
) {
  return run("gemini", ["-p", prompt, "-m", model, "--yolo"], {
    cwd: dir,
    shell: true,
    timeoutMs,
    env: cleanEnv({
      GOOGLE_GEMINI_BASE_URL: ctx.base,
      GEMINI_API_KEY: "dummy",
    }),
  });
}

// ---------- gemini settings guard ----------

const GEMINI_SETTINGS = path.join(os.homedir(), ".gemini", "settings.json");
let geminiBackup; // { existed, content }

function patchGeminiSettings() {
  if (geminiBackup) return;
  const existed = fs.existsSync(GEMINI_SETTINGS);
  const content = existed
    ? fs.readFileSync(GEMINI_SETTINGS, "utf8")
    : undefined;
  geminiBackup = { existed, content };
  fs.writeFileSync(`${GEMINI_SETTINGS}.soak-backup`, content ?? "");
  const json = content ? JSON.parse(content) : {};
  json.security ??= {};
  json.security.auth ??= {};
  json.security.auth.selectedType = "gemini-api-key";
  fs.mkdirSync(path.dirname(GEMINI_SETTINGS), { recursive: true });
  fs.writeFileSync(GEMINI_SETTINGS, JSON.stringify(json, null, 2));
}

function restoreGeminiSettings() {
  if (!geminiBackup) return;
  if (geminiBackup.existed)
    fs.writeFileSync(GEMINI_SETTINGS, geminiBackup.content);
  else fs.rmSync(GEMINI_SETTINGS, { force: true });
  fs.rmSync(`${GEMINI_SETTINGS}.soak-backup`, { force: true });
  geminiBackup = undefined;
}

function needsGemini(name) {
  return name.startsWith("gemini") || name === "concurrent";
}

// ---------- assertions ----------

class Fail extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}
function assertExit(r, what) {
  assert(!r.timedOut, `${what} timed out after ${Math.round(r.ms / 1000)} s`);
  assert(
    r.code === 0,
    `${what} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)}`,
  );
}
function claudeResult(r) {
  try {
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  } catch {
    return { result: r.stdout };
  }
}

// ---------- scenarios ----------

const BUGGY = {
  "add.js": "module.exports = (a, b) => a + b;\n",
  "mul.js": "module.exports = (a, b) => a * b;\n",
  "neg.js": "module.exports = (a) => -a;\n",
};
const BUGGY_CHECK =
  "const a=require('./add.js'),m=require('./mul.js'),n=require('./neg.js');" +
  "console.log(a(2,3)===5&&m(2,3)===6&&n(4)===-4?'ok':'bad')";

const scenarios = {
  async "claude-multifile-edit"(ctx, dir) {
    writeFiles(dir, BUGGY);
    gitInit(dir);
    const r = await claude(
      ctx,
      dir,
      "add.js should add, mul.js should multiply, neg.js should negate. All three are buggy. " +
        "Read all three files in parallel in a single step, then fix each one. Do not create other files.",
    );
    assertExit(r, "claude");
    assert(nodeEval(dir, BUGGY_CHECK) === "ok", "files not fixed");
    const parallel = ctx
      .logSince()
      .some((l) => /tool_use|tools?:\s*[2-9]/i.test(l));
    return {
      note: parallel
        ? "parallel tool use observed in log"
        : "parallel tool use not observable in log",
    };
  },

  async "claude-long-history"(ctx, dir) {
    gitInit(dir);
    const r1 = await claude(
      ctx,
      dir,
      "Remember the code word PELICAN-42. Create notes.txt containing only the word alpha.",
    );
    assertExit(r1, "claude turn 1");
    const r2 = await claude(
      ctx,
      dir,
      "Append a second line beta to notes.txt. Then write the code word I gave you earlier into code.txt.",
      { extraArgs: ["--continue"] },
    );
    assertExit(r2, "claude turn 2 (--continue)");
    const notes = fs.readFileSync(path.join(dir, "notes.txt"), "utf8");
    assert(
      /alpha[\s\S]*beta/.test(notes),
      `notes.txt wrong: ${JSON.stringify(notes)}`,
    );
    const code = fs.existsSync(path.join(dir, "code.txt"))
      ? fs.readFileSync(path.join(dir, "code.txt"), "utf8")
      : "";
    assert(code.includes("PELICAN-42"), "code word lost across --continue");
  },

  async "claude-websearch"(ctx, dir) {
    if (!ctx.webSearchProvider)
      return { skipped: "agentGateway.webSearch.provider not set" };
    const r = await claude(
      ctx,
      dir,
      "Use the WebSearch tool to find the year the Python programming language was first released. " +
        "Answer with the year and include one source URL.",
    );
    assertExit(r, "claude");
    const text = claudeResult(r).result ?? "";
    assert(/1991/.test(text), `answer lacks fact 1991: ${text.slice(0, 300)}`);
    assert(/https?:\/\/\S+/.test(text), "answer lacks a source URL");
  },

  async "claude-image"(ctx, dir) {
    fs.writeFileSync(path.join(dir, "swatch.png"), solidPng(16, [220, 20, 20]));
    const r = await claude(
      ctx,
      dir,
      `Look at the image file ${path.join(dir, "swatch.png")} and tell me its single dominant colour in one word.`,
    );
    assertExit(r, "claude");
    const text = claudeResult(r).result ?? "";
    assert(/\bred\b/i.test(text), `expected red, got: ${text.slice(0, 200)}`);
  },

  async "claude-cancel"(ctx, dir) {
    const since = Date.now();
    const r = await claude(
      ctx,
      dir,
      "Write a 4000 word essay on the history of bridges. Print it directly, do not use tools.",
      {
        extraArgs: ["--output-format", "stream-json", "--verbose"],
        timeoutMs: 120000,
        onStart: (_child, kill) => {
          // Kill 3 s after the gateway sees the request (CLI start-up varies).
          (async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
              if (
                // The gateway logs its per-request settings line when the
                // request starts.
                logLinesSince(since).some((l) =>
                  l.includes("anthropic settings"),
                )
              )
                break;
              await sleep(250);
            }
            await sleep(3000);
            kill();
          })();
        },
      },
    );
    assert(r.killed, "client finished before it could be cancelled");
    let seen = false;
    for (let i = 0; i < 30 && !seen; i++) {
      await sleep(500);
      seen = logLinesSince(since).some((l) =>
        /client disconnected|aborted|cancel/i.test(l),
      );
    }
    assert(seen, "gateway did not log a client disconnect");
    ctx.allowJournal = (e) =>
      e.status === 499 || /abort|cancel|disconnect/i.test(e.kind ?? "");
  },

  async "claude-long-run"(ctx, dir) {
    const r = await claude(
      ctx,
      dir,
      "Write a detailed 5000 word technical guide to TCP congestion control into guide.md using the Write tool. " +
        "Then reply with the word DONE.",
      { model: MODELS.claudeLong, timeoutMs: 600000 },
    );
    assertExit(r, "claude");
    const guide = path.join(dir, "guide.md");
    assert(fs.existsSync(guide), "guide.md missing");
    assert(
      fs.statSync(guide).size > 8000,
      `guide.md too small (${fs.statSync(guide).size} B)`,
    );
    assert(
      r.ms > 60000,
      `run finished in ${Math.round(r.ms / 1000)} s; needs > 60 s to count`,
    );
  },

  // With no client limit the gateway must not cut a
  // long answer short (no fabricated max_tokens stop).
  async "claude-long-answer"(ctx, dir) {
    const r = await claude(
      ctx,
      dir,
      "Write a 600-word essay on the history of lighthouses into essay.md using the Write tool. " +
        "Then reply with the word DONE.",
      { model: MODELS.claudeLong, timeoutMs: 300000 },
    );
    assertExit(r, "claude");
    const essay = path.join(dir, "essay.md");
    assert(fs.existsSync(essay), "essay.md missing");
    const words = fs
      .readFileSync(essay, "utf8")
      .split(/\s+/)
      .filter(Boolean).length;
    assert(words >= 450, `essay.md cut short (${words} words, need >= 450)`);
    return { note: `${words} words` };
  },

  async "codex-shell-patch"(ctx, dir) {
    writeFiles(dir, BUGGY);
    gitInit(dir);
    const r = await codex(
      ctx,
      dir,
      "add.js should add, mul.js should multiply, neg.js should negate. Run `node -e` to observe the bugs, " +
        "then fix all three files with apply_patch, then verify with node.",
    );
    assertExit(r, "codex");
    assert(nodeEval(dir, BUGGY_CHECK) === "ok", "files not fixed");
  },

  async "codex-live-search"(ctx, dir) {
    gitInit(dir);
    const r = await codex(
      ctx,
      dir,
      "Search the web for the year the Rust programming language reached version 1.0. " +
        "Then use a shell command to create the file year.txt in the current directory " +
        "containing just that year. Creating the file is required.",
      { extra: ["-c", 'web_search="live"'] },
    );
    assertExit(r, "codex");
    const f = path.join(dir, "year.txt");
    assert(
      fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("2015"),
      "year.txt missing or not 2015",
    );
  },

  async "codex-effort"(ctx, dir) {
    gitInit(dir);
    const r = await codex(
      ctx,
      dir,
      "Compute the 20th Fibonacci number (F1=1, F2=1) and write only the number into fib.txt.",
      { extra: ["-c", 'model_reasoning_effort="high"'] },
    );
    assertExit(r, "codex");
    const f = path.join(dir, "fib.txt");
    assert(
      fs.existsSync(f) && fs.readFileSync(f, "utf8").trim() === "6765",
      "fib.txt is not 6765",
    );
  },

  async "codex-cache-key"(ctx, dir) {
    gitInit(dir);
    const since = Date.now();
    const r1 = await codex(ctx, dir, "Create a.txt containing exactly: one");
    assertExit(r1, "codex turn 1");
    const r2 = await codex(
      ctx,
      dir,
      "Now create b.txt containing exactly: two",
      { resume: true },
    );
    assertExit(r2, "codex turn 2 (resume)");
    assert(
      fs.existsSync(path.join(dir, "a.txt")) &&
        fs.readFileSync(path.join(dir, "a.txt"), "utf8").trim() === "one",
      "a.txt wrong",
    );
    assert(
      fs.existsSync(path.join(dir, "b.txt")) &&
        fs.readFileSync(path.join(dir, "b.txt"), "utf8").trim() === "two",
      "b.txt wrong",
    );
    // The gateway's per-request id is what it returns as x-request-id.
    const ids = new Set(
      logLinesSince(since)
        .filter((l) => /responses/.test(l) && /status=200/.test(l))
        // Skip the "[info]" level tag; the request id is the next bracket.
        .map((l) => /\] \[([\w.:-]+)\] openai POST/.exec(l)?.[1])
        .filter(Boolean),
    );
    assert(
      ids.size >= 2,
      `expected >= 2 distinct request ids for /v1/responses, saw ${ids.size}`,
    );
  },

  async "gemini-tools-edit"(ctx, dir) {
    writeFiles(dir, BUGGY);
    gitInit(dir);
    const r = await gemini(
      ctx,
      dir,
      "add.js should add, mul.js should multiply, neg.js should negate. All three are buggy; fix each file in place.",
    );
    assertExit(r, "gemini");
    assert(nodeEval(dir, BUGGY_CHECK) === "ok", "files not fixed");
  },

  async "gemini-search"(ctx, dir) {
    const r = await gemini(
      ctx,
      dir,
      "Use google_web_search to find the year the Go programming language was first publicly announced. " +
        "Answer with the year and a source URL.",
    );
    assertExit(r, "gemini");
    assert(
      /2009/.test(r.stdout),
      `answer lacks 2009: ${r.stdout.slice(0, 300)}`,
    );
    assert(/https?:\/\//.test(r.stdout), "answer lacks a URL");
  },

  async "gemini-fetch"(ctx, dir) {
    const r = await gemini(
      ctx,
      dir,
      "Use web_fetch to read https://example.com and tell me the exact text of its main heading.",
    );
    assertExit(r, "gemini");
    assert(
      /Example Domain/i.test(r.stdout),
      `answer lacks 'Example Domain': ${r.stdout.slice(0, 300)}`,
    );
  },

  async concurrent(ctx, dir) {
    const dirs = ["claude", "codex", "gemini"].map((n) => {
      const d = path.join(dir, n);
      fs.mkdirSync(d, { recursive: true });
      writeFiles(d, BUGGY);
      gitInit(d);
      return d;
    });
    const prompt =
      "add.js should add, mul.js should multiply, neg.js should negate. Fix all three files in place.";
    const [rc, rx, rg] = await Promise.all([
      claude(ctx, dirs[0], prompt),
      codex(ctx, dirs[1], prompt),
      gemini(ctx, dirs[2], prompt),
    ]);
    const problems = [];
    for (const [r, d, n] of [
      [rc, dirs[0], "claude"],
      [rx, dirs[1], "codex"],
      [rg, dirs[2], "gemini"],
    ]) {
      try {
        assertExit(r, n);
        assert(nodeEval(d, BUGGY_CHECK) === "ok", `${n}: files not fixed`);
      } catch (e) {
        problems.push(e.message);
      }
    }
    assert(problems.length === 0, problems.join("; "));
  },
};

const ORDER = Object.keys(scenarios);

// ---------- main ----------

function readWebSearchProvider() {
  for (const n of ["Code", "Code - Insiders"]) {
    const f = path.join(process.env.APPDATA ?? "", n, "User", "settings.json");
    if (!fs.existsSync(f)) continue;
    const m = /"agentGateway\.webSearch\.provider"\s*:\s*"([^"]*)"/.exec(
      fs.readFileSync(f, "utf8"),
    );
    if (m && m[1]) return m[1];
  }
  return process.env.SOAK_WEBSEARCH_PROVIDER || undefined;
}

function markdown(summary) {
  const rows = summary.results.map(
    (r) =>
      `| ${r.scenario} | ${r.status} | ${(r.durationMs / 1000).toFixed(1)} | ${(r.reason ?? r.note ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`,
  );
  return [
    `# Soak run ${summary.label}`,
    "",
    `- Base: ${summary.base}`,
    `- Started: ${summary.startedAt}`,
    `- Passed: ${summary.passed} / Failed: ${summary.failed} / Skipped: ${summary.skipped}`,
    "",
    "| Scenario | Status | Seconds | Reason / note |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Scenarios: ${ORDER.join(", ")}`);
    return 0;
  }
  const selected = opts.only ?? ORDER;
  for (const s of selected)
    if (!scenarios[s]) throw new Error(`Unknown scenario ${s}`);

  await health(opts.base); // fail fast if the gateway is down
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = opts.label ?? stamp;
  const root = path.join(os.tmpdir(), "agent-gateway-soak", stamp);
  fs.mkdirSync(root, { recursive: true });
  const webSearchProvider = readWebSearchProvider();
  console.log(`soak: base=${opts.base} scratch=${root}`);

  const results = [];
  const startedAt = new Date().toISOString();
  try {
    if (selected.some(needsGemini)) patchGeminiSettings();
    for (const name of selected) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      const since = Date.now();
      const ctx = {
        base: opts.base,
        webSearchProvider,
        allowJournal: undefined,
        logSince: () => logLinesSince(since),
      };
      process.stdout.write(`- ${name} ... `);
      let entry;
      try {
        const out = (await scenarios[name](ctx, dir)) ?? {};
        if (out.skipped) {
          entry = { status: "skip", reason: out.skipped };
        } else {
          await sleep(500);
          const errs = await journalErrorsSince(
            opts.base,
            since,
            ctx.allowJournal,
          );
          entry =
            errs.length > 0
              ? {
                  status: "fail",
                  reason: `gateway journal errors: ${errs.map((e) => `${e.status} ${e.method} ${e.path}`).join(", ")}`,
                }
              : { status: "pass", note: out.note };
        }
      } catch (e) {
        entry = {
          status: "fail",
          reason: e instanceof Fail ? e.message : `error: ${e.stack ?? e}`,
        };
        try {
          const errs = await journalErrorsSince(
            opts.base,
            since,
            ctx.allowJournal,
          );
          if (errs.length)
            entry.reason += ` | journal: ${errs.map((x) => `${x.status} ${x.path}`).join(", ")}`;
        } catch {}
      }
      entry = {
        scenario: name,
        durationMs: Date.now() - since,
        scratch: dir,
        ...entry,
      };
      results.push(entry);
      console.log(
        `${entry.status} (${(entry.durationMs / 1000).toFixed(1)} s)${entry.reason ? ` - ${entry.reason}` : ""}`,
      );
    }
  } finally {
    restoreGeminiSettings();
  }

  const summary = {
    label,
    base: opts.base,
    startedAt: startedAt,
    scratch: root,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
    results,
  };
  const outDir = path.join(HERE, "results", label);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(outDir, "summary.md"), markdown(summary));
  console.log(
    `soak: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped -> ${outDir}`,
  );
  return summary.failed > 0 ? 1 : 0;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of liveChildren) killTree(c);
    restoreGeminiSettings();
    process.exit(130);
  });
}
process.on("exit", restoreGeminiSettings);

main().then(
  (code) => process.exit(code),
  (e) => {
    restoreGeminiSettings();
    console.error(e);
    process.exit(2);
  },
);
