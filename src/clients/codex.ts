// Codex CLI / Codex desktop adapter. Edits ~/.codex/config.toml surgically:
// only the top-level model_provider/model/context keys and the
// [model_providers.agent-gateway] table are touched.
import * as path from "path";

import { selectedContextWindow } from "./contextWindow";
import {
  ClientAdapter,
  ClientConfigInput,
  ClientPlan,
  GATEWAY_PROVIDER_ID,
  GATEWAY_PROVIDER_NAME,
  PLACEHOLDER_API_KEY,
} from "./types";

const MARKER_PREFIX = "# agent-gateway previous:";
const UNSET = "<unset>";
const CONTEXT_KEY = "model_context_window";
const CONTEXT_MARKER = "# agent-gateway previous context:";
const TOP_KEYS = ["model_provider", "model"] as const;

function codexConfigPath(home: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(home, ".codex", "config.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HEADER_RE = /^\s*\[\[?\s*[^\]]+\]\]?\s*(#.*)?$/;
const PROVIDER_HEADER_RE = new RegExp(
  `^\\s*\\[\\s*model_providers\\s*\\.\\s*(?:${escapeRe(GATEWAY_PROVIDER_ID)}|"${escapeRe(
    GATEWAY_PROVIDER_ID,
  )}")\\s*\\]\\s*(#.*)?$`,
);

/** Net bracket depth change of a line, ignoring strings and comments. */
function bracketDelta(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      break;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
    }
  }
  return depth;
}

/** Indexes of lines that are real table headers (not inside multi-line arrays). */
function headerIndexes(lines: string[]): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0 && HEADER_RE.test(line)) {
      out.push(i);
      continue;
    }
    if (depth > 0 || /^\s*[^#\s][^=]*=/.test(line)) {
      depth = Math.max(0, depth + bracketDelta(line));
    }
  }
  return out;
}

interface Parsed {
  lines: string[];
  eol: string;
  /** End (exclusive) of the top-level region. */
  topEnd: number;
  /** Provider table [start, end) or undefined. */
  table?: { start: number; end: number };
}

function parse(text: string): Parsed {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const headers = headerIndexes(lines);
  const topEnd = headers.length ? headers[0] : lines.length;
  let table: Parsed["table"];
  for (let h = 0; h < headers.length; h++) {
    if (PROVIDER_HEADER_RE.test(lines[headers[h]])) {
      table = {
        start: headers[h],
        end: h + 1 < headers.length ? headers[h + 1] : lines.length,
      };
      break;
    }
  }
  return { lines, eol, topEnd, table };
}

function topKeyRe(key: string): RegExp {
  return new RegExp(`^\\s*(?:${key}|"${key}")\\s*=\\s*(.*)$`);
}

/** Raw TOML value of a top-level key (trailing comment stripped), or undefined. */
function findTopKey(
  p: Parsed,
  key: string,
): { index: number; raw: string } | undefined {
  const re = topKeyRe(key);
  for (let i = 0; i < p.topEnd; i++) {
    const m = re.exec(p.lines[i]);
    if (m) {
      return { index: i, raw: stripComment(m[1]).trim() };
    }
  }
  return undefined;
}

function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return value.slice(0, i);
    }
  }
  return value;
}

function readMarker(p: Parsed): Record<string, string> | undefined {
  if (!p.table) {
    return undefined;
  }
  for (let i = p.table.start + 1; i < p.table.end; i++) {
    const line = p.lines[i].trim();
    if (line.startsWith(MARKER_PREFIX)) {
      const m = /model_provider=(.*?), model=(.*)$/.exec(
        line.slice(MARKER_PREFIX.length).trim(),
      );
      if (m) {
        const result: Record<string, string> = {
          model_provider: m[1],
          model: m[2],
        };
        const context = p.lines
          .slice(p.table.start + 1, p.table.end)
          .map((line) => line.trim())
          .find((line) => line.startsWith(CONTEXT_MARKER));
        if (context) {
          result[CONTEXT_KEY] = context.slice(CONTEXT_MARKER.length).trim();
        }
        return result;
      }
    }
  }
  return undefined;
}

function unquote(raw: string): string {
  try {
    return raw.startsWith('"')
      ? (JSON.parse(raw) as string)
      : raw.replace(/^'|'$/g, "");
  } catch {
    return raw;
  }
}

/** Remove trailing empty lines from an array of lines (in place) but keep one final "". */
function join(lines: string[], eol: string): string {
  return lines.join(eol);
}

function buildTable(
  input: ClientConfigInput,
  marker: Record<string, string>,
): string[] {
  const key = input.apiKey || PLACEHOLDER_API_KEY;
  return [
    `[model_providers.${GATEWAY_PROVIDER_ID}]`,
    `${MARKER_PREFIX} model_provider=${marker.model_provider}, model=${marker.model}`,
    ...(CONTEXT_KEY in marker
      ? [`${CONTEXT_MARKER} ${marker[CONTEXT_KEY]}`]
      : []),
    `name = ${tomlString(GATEWAY_PROVIDER_NAME)}`,
    `base_url = ${tomlString(`${input.gatewayUrl.replace(/\/+$/, "")}/v1`)}`,
    `wire_api = "responses"`,
    `experimental_bearer_token = ${tomlString(key)}`,
  ];
}

/** Removes the provider table and the blank lines directly before it. */
function removeTable(
  lines: string[],
  table: { start: number; end: number },
): string[] {
  let start = table.start;
  let end = table.end;
  // Drop trailing blank lines of the table body but keep one separator.
  while (end > start + 1 && lines[end - 1].trim() === "") {
    end--;
  }
  const isLast = table.end === lines.length;
  if (isLast) {
    while (start > 0 && lines[start - 1].trim() === "") {
      start--;
    }
    const tail = lines.slice(table.end);
    const rest = lines.slice(0, start);
    return rest.length && tail.length === 0
      ? [...rest, ""]
      : [...rest, ...tail];
  }
  // Remove the table plus the blank lines that separated it from the next header.
  return [...lines.slice(0, start), ...lines.slice(table.end)];
}

function planCodex(
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): ClientPlan {
  const file = codexConfigPath(input.home, input.platform);
  const before = files[file];
  const summary: string[] = [];
  let p = parse(before ?? "");

  // Previous values: keep an existing marker so re-running stays idempotent.
  const marker = readMarker(p) ?? {
    model_provider: findTopKey(p, "model_provider")?.raw ?? UNSET,
    model: findTopKey(p, "model")?.raw ?? UNSET,
  };

  const capacity = selectedContextWindow(input);
  if (capacity !== undefined && !(CONTEXT_KEY in marker)) {
    marker[CONTEXT_KEY] = findTopKey(p, CONTEXT_KEY)?.raw ?? UNSET;
  }

  // 1. Upsert the provider table.
  const tableLines = buildTable(input, marker);
  let lines = p.lines.slice();
  if (p.table) {
    let end = p.table.end;
    while (end > p.table.start + 1 && lines[end - 1].trim() === "") {
      end--;
    }
    lines.splice(p.table.start, end - p.table.start, ...tableLines);
    summary.push(`Update [model_providers.${GATEWAY_PROVIDER_ID}] in ${file}`);
  } else {
    while (lines.length && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length) {
      lines.push("");
    }
    lines.push(...tableLines, "");
    summary.push(`Add [model_providers.${GATEWAY_PROVIDER_ID}] to ${file}`);
  }

  // 2. Set top-level keys (before the first table header).
  p = parse(join(lines, p.eol));
  lines = p.lines.slice();
  const values: Record<string, string> = {
    model_provider: tomlString(GATEWAY_PROVIDER_ID),
    model: tomlString(input.defaultModel),
  };
  if (capacity !== undefined) {
    values[CONTEXT_KEY] = String(capacity);
  } else if (CONTEXT_KEY in marker) {
    values[CONTEXT_KEY] = marker[CONTEXT_KEY];
  }
  const inserts: string[] = [];
  const removals: number[] = [];
  for (const key of Object.keys(values)) {
    const found = findTopKey(p, key);
    if (values[key] === UNSET) {
      if (found) {
        removals.push(found.index);
      }
    } else if (found) {
      lines[found.index] = `${key} = ${values[key]}`;
    } else {
      inserts.push(`${key} = ${values[key]}`);
    }
  }
  for (const i of removals.sort((a, b) => b - a)) {
    lines.splice(i, 1);
  }
  if (inserts.length) {
    // An empty top region directly followed by a header needs a separator.
    const needsBlank = p.topEnd === 0 && lines.some((l) => l.trim() !== "");
    lines.splice(0, 0, ...inserts, ...(needsBlank ? [""] : []));
  }
  summary.push(
    `Set model_provider = "${GATEWAY_PROVIDER_ID}" and model = "${input.defaultModel}" (previous: model_provider=${marker.model_provider}, model=${marker.model})`,
  );
  summary.push(
    `Authenticate with experimental_bearer_token (${input.apiKey ? "gateway API key" : "placeholder; gateway has no key"})`,
  );
  if (capacity !== undefined) {
    summary.push(
      `Set model_context_window = ${capacity} from the selected model metadata; reconfigure after changing models.`,
    );
  } else if (CONTEXT_KEY in marker) {
    summary.push(
      "Context metadata unavailable; restored the pre-gateway context setting instead of retaining stale capacity.",
    );
  } else if (findTopKey(p, CONTEXT_KEY)) {
    summary.push(
      "Note: top-level model_context_window is set and left unchanged; it may not match the gateway model",
    );
  }

  const after = join(lines, p.eol);
  return {
    changes: before === after ? [] : [{ path: file, before, after }],
    summary,
    afterApply:
      "Restart Codex (CLI session or desktop app); models are listed from the gateway.",
  };
}

function unplanCodex(
  input: ClientConfigInput,
  files: Record<string, string | undefined>,
): ClientPlan {
  const file = codexConfigPath(input.home, input.platform);
  const before = files[file];
  const summary: string[] = [];
  if (before === undefined) {
    return {
      changes: [],
      summary: [`${file} does not exist; nothing to remove`],
    };
  }
  let p = parse(before);
  const marker = readMarker(p);
  let lines = p.lines.slice();
  if (p.table) {
    lines = removeTable(lines, p.table);
    summary.push(
      `Remove [model_providers.${GATEWAY_PROVIDER_ID}] from ${file}`,
    );
  }

  p = parse(join(lines, p.eol));
  lines = p.lines.slice();
  const current = findTopKey(p, "model_provider");
  if (current && unquote(current.raw) === GATEWAY_PROVIDER_ID) {
    const removals: number[] = [];
    const inserts: string[] = [];
    const keys = [
      ...TOP_KEYS,
      ...(marker && CONTEXT_KEY in marker ? [CONTEXT_KEY] : []),
    ];
    for (const key of keys) {
      const found = findTopKey(p, key);
      if (marker) {
        const prev = marker[key];
        if (prev === UNSET) {
          if (found) {
            removals.push(found.index);
          }
        } else if (found) {
          lines[found.index] = `${key} = ${prev}`;
        } else {
          inserts.push(`${key} = ${prev}`);
        }
      } else if (key === "model_provider" && found) {
        removals.push(found.index);
      }
    }
    for (const i of removals.sort((a, b) => b - a)) {
      lines.splice(i, 1);
    }
    lines.unshift(...inserts);
    if (marker) {
      summary.push(
        `Restore model_provider=${marker.model_provider}, model=${marker.model}`.replace(
          /<unset>/g,
          "(unset)",
        ),
      );
    } else {
      summary.push(
        "Previous model_provider unknown; leaving it unset (Codex default). model left unchanged",
      );
    }
  }
  // Drop a leading blank line left behind by removed keys.
  while (
    lines.length > 1 &&
    lines[0].trim() === "" &&
    before.length &&
    before.split(/\r?\n/)[0].trim() !== ""
  ) {
    lines.shift();
  }

  const after = join(lines, p.eol);
  return {
    changes: before === after ? [] : [{ path: file, before, after }],
    summary: summary.length
      ? summary
      : ["Codex is not configured for the gateway; nothing to remove"],
    afterApply: "Restart Codex to pick up the change.",
  };
}

const WEB_SEARCH_MARKER = "# agent-gateway previous web_search:";

/**
 * Codex sends `web_search` with `external_web_access: true` only in "live"
 * mode; its default ("cached") is treated by the gateway as no search. Sets
 * the top-level key to "live" while a gateway search engine is enabled and
 * restores the recorded previous value when it is turned off.
 */
export function planCodexWebSearch(
  home: string,
  platform: NodeJS.Platform,
  files: Record<string, string | undefined>,
  enable: boolean,
): ClientPlan {
  const file = codexConfigPath(home, platform);
  const before = files[file];
  if (before === undefined) {
    return {
      changes: [],
      summary: [`${file} does not exist; Codex web search not changed`],
    };
  }
  const p = parse(before);
  const lines = p.lines.slice();
  const markerIndex = lines
    .slice(0, p.topEnd)
    .findIndex((l) => l.trim().startsWith(WEB_SEARCH_MARKER));
  const found = findTopKey(p, "web_search");
  const summary: string[] = [];

  if (enable) {
    if (found && unquote(found.raw) === "live") {
      return {
        changes: [],
        summary: ['Codex web_search is already "live"'],
      };
    }
    const previous = markerIndex >= 0 ? undefined : (found?.raw ?? UNSET);
    if (found) {
      lines[found.index] = `web_search = "live"`;
    } else {
      lines.splice(0, 0, `web_search = "live"`);
    }
    if (previous !== undefined) {
      const at = found ? found.index : 0;
      lines.splice(at, 0, `${WEB_SEARCH_MARKER} ${previous}`);
    }
    summary.push(
      `Set web_search = "live" in ${file} (previous: ${found?.raw ?? 'unset, Codex default "cached"'})`,
    );
  } else {
    if (markerIndex < 0) {
      return {
        changes: [],
        summary: [
          "Codex web_search was not set by the gateway; left unchanged",
        ],
      };
    }
    const previous = lines[markerIndex]
      .trim()
      .slice(WEB_SEARCH_MARKER.length)
      .trim();
    // Edit the later line first so the earlier index stays valid.
    const keyIndex = found?.index ?? -1;
    const edits = [
      { index: markerIndex, remove: true },
      ...(found ? [{ index: keyIndex, remove: previous === UNSET }] : []),
    ].sort((a, b) => b.index - a.index);
    for (const edit of edits) {
      if (edit.remove) {
        lines.splice(edit.index, 1);
      } else {
        lines[edit.index] = `web_search = ${previous}`;
      }
    }
    summary.push(
      `Restore Codex web_search to ${previous === UNSET ? "its default" : previous} in ${file}`,
    );
  }

  const after = join(lines, p.eol);
  return {
    changes: before === after ? [] : [{ path: file, before, after }],
    summary,
    afterApply: "Restart Codex to pick up the web search change.",
  };
}

export const codexAdapter: ClientAdapter = {
  id: "codex",
  label: "Codex CLI / Codex desktop",
  discovery: "auto",
  caveat:
    "Codex is expected to list models from <base_url>/models (verified in the binary, not observed live for custom providers). CODEX_HOME overrides are not honoured.",
  detectPaths: (home, platform) => [
    (platform === "win32" ? path.win32 : path.posix).join(home, ".codex"),
  ],
  configPaths: (home, platform) => [codexConfigPath(home, platform)],
  plan: planCodex,
  unplan: unplanCodex,
};
