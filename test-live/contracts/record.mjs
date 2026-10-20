// Recording proxy: forwards every request to a gateway unchanged and keeps a
// redacted shape of the traffic (key paths, value types and the distinct
// values of discriminator fields). Prompt text, tool schemas, arguments,
// credentials and header values are never stored.
//
//   node test-live/contracts/record.mjs [--target http://127.0.0.1:24444] [--port 0] [--out shape.json]
//
// Stop with Ctrl+C; the shape is printed (or written to --out) on exit.
import http from "node:http";
import zlib from "node:zlib";

/** Header values that are safe and useful to keep. */
const HEADER_VALUES = new Set(["content-type", "anthropic-version"]);
/** Comma-separated header values kept as sets. */
const HEADER_LISTS = new Set(["anthropic-beta"]);
/** Header names that vary per request or machine and say nothing about the contract. */
const HEADER_SKIP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * Keys whose value is user or tool content: the type is recorded but the
 * subtree is not walked (it holds JSON schemas, arguments or free-form maps).
 */
const OPAQUE_KEYS = new Set([
  "parameters",
  "parametersJsonSchema",
  "input_schema",
  "inputSchema",
  "schema",
  "json_schema",
  "responseSchema",
  "responseJsonSchema",
  "arguments",
  "args",
  "input",
  "metadata",
  "format",
  "headers",
  "env",
  "properties",
  "response",
  "functionResponse",
]);
/** `input` is opaque only inside tool calls; at the top of a Responses request it is the item list. */
const STRUCTURAL_AT_ROOT = new Set(["input"]);

export function createRecorder() {
  /** endpoint key -> { field -> Set } */
  const endpoints = new Map();

  function bucket(key) {
    let b = endpoints.get(key);
    if (!b) {
      b = new Map();
      endpoints.set(key, b);
    }
    return b;
  }
  function add(b, field, value) {
    if (value === undefined || value === null || value === "") return;
    let s = b.get(field);
    if (!s) b.set(field, (s = new Set()));
    s.add(String(value));
  }

  function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
  }

  function walk(b, value, path, depth) {
    add(b, "body.paths", `${path || "$"}:${typeOf(value)}`);
    if (depth > 12 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(b, item, `${path}[]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      if (k === "type" && typeof v === "string")
        add(b, `type@${path || "$"}`, v);
      if (k === "role" && typeof v === "string") add(b, "role", v);
      if (
        OPAQUE_KEYS.has(k) &&
        !(path === "" && STRUCTURAL_AT_ROOT.has(k) && Array.isArray(v))
      ) {
        add(b, "body.paths", `${child}:${typeOf(v)}`);
        continue;
      }
      walk(b, v, child, depth + 1);
    }
  }

  function tools(b, list) {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || typeof t !== "object") continue;
      // Gemini: one object per tool family (functionDeclarations, googleSearch, ...).
      if (!("type" in t) && !("name" in t))
        for (const k of Object.keys(t)) add(b, "tools.keys", k);
      if (typeof t.type !== "string") continue;
      add(b, "tools.type", t.type);
      // Names of built-in / non-function tools identify client features.
      // Namespace names can be the user's MCP servers, so they are skipped.
      if (
        t.type !== "function" &&
        t.type !== "namespace" &&
        typeof t.name === "string"
      )
        add(b, "tools.builtin", `${t.type}:${t.name}`);
      tools(b, t.tools);
    }
  }

  function discriminators(b, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (typeof body.model === "string") add(b, "model", body.model);
    if (typeof body.stream === "boolean") add(b, "stream", body.stream);
    const tc = body.tool_choice;
    if (typeof tc === "string") add(b, "tool_choice", tc);
    else if (tc && typeof tc === "object")
      add(b, "tool_choice", tc.type ?? tc.mode);
    if (body.reasoning && typeof body.reasoning === "object") {
      add(b, "reasoning.effort", body.reasoning.effort);
      add(b, "reasoning.summary", body.reasoning.summary);
    }
    if (typeof body.reasoning_effort === "string")
      add(b, "reasoning.effort", body.reasoning_effort);
    if (Array.isArray(body.include))
      for (const i of body.include) add(b, "include", i);
    if (body.thinking && typeof body.thinking === "object")
      add(b, "thinking.type", body.thinking.type);
    tools(b, body.tools);
    // Codex also sends tools inside input items (additional_tools) and namespaces.
    if (Array.isArray(body.input))
      for (const item of body.input) if (item) tools(b, item.tools);
    if (body.generationConfig && typeof body.generationConfig === "object")
      for (const k of Object.keys(body.generationConfig))
        add(b, "generationConfig.keys", k);
  }

  /** Records one request; returns a sink for the response. */
  function request({ method, url, headers, body }) {
    const u = new URL(url, "http://x");
    let model;
    // Gemini puts the model in the path: /v1beta/models/<model>:<action>.
    const pathname = u.pathname.replace(
      /\/models\/([^/:]+)(?=:|$)/,
      (_, id) => {
        model = id;
        return "/models/{model}";
      },
    );
    const b = bucket(`${method} ${pathname}`);
    add(b, "count", "seen");
    if (model) add(b, "model", decodeURIComponent(model));
    for (const k of u.searchParams.keys()) add(b, "query", k);
    for (const [name, value] of Object.entries(headers)) {
      const n = name.toLowerCase();
      if (HEADER_SKIP.has(n)) continue;
      add(b, "headers", n);
      if (HEADER_VALUES.has(n))
        add(b, `header:${n}`, String(value).split(";")[0].trim());
      if (HEADER_LISTS.has(n))
        for (const v of String(value).split(","))
          add(b, `header:${n}`, v.trim());
    }
    if (body && body.length) {
      let parsed;
      try {
        parsed = JSON.parse(decode(body, headers["content-encoding"]));
      } catch {
        add(b, "body.paths", "$:unparsed");
      }
      if (parsed !== undefined) {
        walk(b, parsed, "", 0);
        discriminators(b, parsed);
      }
    }
    return {
      status(code) {
        add(b, "status", code);
      },
      sse(event) {
        add(b, "sse", event);
      },
    };
  }

  /** Sorted, deterministic shape. */
  function shape() {
    const out = {};
    for (const key of [...endpoints.keys()].sort()) {
      const b = endpoints.get(key);
      const e = {};
      for (const f of [...b.keys()].sort()) {
        if (f === "count") continue;
        e[f] = [...b.get(f)].sort();
      }
      out[key] = e;
    }
    return out;
  }

  return { request, shape };
}

function decode(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  if (enc === "gzip") buf = zlib.gunzipSync(buf);
  else if (enc === "deflate") buf = zlib.inflateSync(buf);
  else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
  else if (enc === "zstd") buf = zlib.zstdDecompressSync(buf);
  return buf.toString("utf8");
}

/** Parses SSE text incrementally and reports event names and chunk types. */
function sseParser(onEvent) {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) {
      if (line.startsWith("event:")) onEvent(`event:${line.slice(6).trim()}`);
      else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          onEvent("data:[DONE]");
          continue;
        }
        try {
          const j = JSON.parse(data);
          if (j && typeof j === "object") {
            if (typeof j.type === "string") onEvent(`data.type:${j.type}`);
            if (typeof j.object === "string")
              onEvent(`data.object:${j.object}`);
            if (Array.isArray(j.candidates)) onEvent("data:candidates");
          }
        } catch {
          // non-JSON data lines carry no contract information
        }
      }
    }
  };
}

/**
 * Starts the proxy on 127.0.0.1. Resolves with { url, recorder, close }.
 */
export function startProxy({
  target = "http://127.0.0.1:24444",
  port = 0,
} = {}) {
  const recorder = createRecorder();
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sink = recorder.request({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const headers = { ...req.headers, host: t.host };
      const up = http.request(
        {
          hostname: t.hostname,
          port: t.port,
          method: req.method,
          path: req.url,
          headers,
        },
        (upRes) => {
          sink.status(upRes.statusCode);
          res.writeHead(upRes.statusCode, upRes.headers);
          const isSse = String(upRes.headers["content-type"] || "").includes(
            "text/event-stream",
          );
          const parse =
            isSse && !upRes.headers["content-encoding"]
              ? sseParser((e) => sink.sse(e))
              : undefined;
          upRes.on("data", (c) => {
            parse?.(c.toString("utf8"));
            res.write(c);
          });
          upRes.on("end", () => res.end());
          upRes.on("error", () => res.destroy());
        },
      );
      up.on("error", (err) => {
        sink.status(`proxy-error:${err.code || "unknown"}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        recorder,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ---------- standalone use ----------

if (process.argv[1]?.replace(/\\/g, "/").endsWith("contracts/record.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const { url, recorder, close } = await startProxy({
    target: opt("--target", "http://127.0.0.1:24444"),
    port: Number(opt("--port", "0")),
  });
  console.error(`recording proxy on ${url}; Ctrl+C to stop`);
  const finish = async () => {
    await close();
    const text = JSON.stringify(recorder.shape(), null, 2) + "\n";
    const out = opt("--out");
    if (out) (await import("node:fs")).writeFileSync(out, text);
    else process.stdout.write(text);
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
}
