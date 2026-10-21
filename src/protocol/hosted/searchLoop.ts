import { createSafeLogger } from "../core/log";
import type { HostedHook } from "../core/runTurn";
import type {
  CoreEvent,
  CoreLogger,
  CoreRequest,
  FetchedPage,
  HostedErrorCode,
  HostedFetchTool,
  HostedSearchTool,
  NormalizedUsage,
  Part,
  Source,
  ToolCallPart,
  ToolDef,
  ToolMode,
  ToolResultPart,
  Turn,
} from "../core/types";
import { CitationRegistry, toSource } from "./citations";
import { EngineError } from "./engines/engine";
import type { FetchResult, WebFetchEngine, WebSearchEngine } from "./types";
import { capPage } from "./urlContext";
import { checkUrl } from "./urlSafety";

/** Default per-tool budget when the client gives none. */
export const DEFAULT_MAX_USES = 5;
export const MAX_CONCURRENT_SEARCHES = 4;
/** Hard cap on model rounds, independent of the search budget. */
export const MAX_ROUNDS = 12;
export const INTERNAL_SEARCH_TOOL_BASE = "gateway_web_search";
export const INTERNAL_FETCH_TOOL_BASE = "gateway_web_fetch";
/** Longest URL the fetch tool accepts (Anthropic's limit). */
export const MAX_FETCH_URL_LENGTH = 250;

/** Picks a name for the internal tool that no client tool uses. */
export function internalToolName(clientTools: readonly ToolDef[]): string {
  const taken = new Set(clientTools.map((t) => t.name));
  let name = INTERNAL_SEARCH_TOOL_BASE;
  for (let i = 2; taken.has(name); i++) {
    name = `${INTERNAL_SEARCH_TOOL_BASE}_${i}`;
  }
  return name;
}

/** Internal search and fetch tool names that no client tool uses. */
export function internalToolNames(clientTools: readonly ToolDef[]): {
  searchName: string;
  fetchName: string;
} {
  const searchName = internalToolName(clientTools);
  const taken = new Set([...clientTools.map((t) => t.name), searchName]);
  let fetchName = INTERNAL_FETCH_TOOL_BASE;
  for (let i = 2; taken.has(fetchName); i++) {
    fetchName = `${INTERNAL_FETCH_TOOL_BASE}_${i}`;
  }
  return { searchName, fetchName };
}

export function internalFetchToolDef(name: string): ToolDef {
  return {
    name,
    description:
      "Fetch a web page and return its text. Only URLs that already appear in the conversation (the user's messages, tool results or earlier search results) can be fetched.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

export function internalSearchToolDef(name: string): ToolDef {
  return {
    name,
    description:
      "Search the web for current information. Returns numbered results with title, URL and excerpt. Cite results as [n].",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export interface Budget {
  limit: number;
  /** Error code used when the budget is exhausted. */
  code: Extract<
    HostedErrorCode,
    "max_uses_exceeded" | "max_tool_calls_exceeded"
  >;
}

/** `min(setting, max_uses ?? 5, max_tool_calls)`. */
export function computeBudget(
  setting: number,
  maxUses: number | undefined,
  maxToolCalls?: number,
): Budget {
  const uses = Math.min(
    Math.max(0, Math.floor(setting)),
    Math.max(0, Math.floor(maxUses ?? DEFAULT_MAX_USES)),
  );
  if (maxToolCalls !== undefined && maxToolCalls < uses) {
    return {
      limit: Math.max(0, Math.floor(maxToolCalls)),
      code: "max_tool_calls_exceeded",
    };
  }
  return { limit: uses, code: "max_uses_exceeded" };
}

/** Counting semaphore for the parallel search dispatch. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly slots: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** One model round: a request in, a core event stream out. */
export type ModelRound = (req: CoreRequest) => AsyncIterable<CoreEvent>;

export interface SearchLoopOptions {
  /** The client request as decoded (hosted search tool in `req.hosted`). */
  req: CoreRequest;
  /** Hosted search tool; absent when only fetch is offered. */
  tool?: HostedSearchTool;
  engine?: WebSearchEngine;
  /** Hosted fetch tool the model calls (Anthropic web_fetch). */
  fetchTool?: HostedFetchTool;
  fetchEngine?: WebFetchEngine;
  /** `agentGateway.webSearch.maxSearchesPerRequest`. */
  maxSearchesPerRequest: number;
  /** Responses `max_tool_calls`, when sent. */
  maxToolCalls?: number;
  /** Runs one model round; called once per round. */
  callModel: ModelRound;
  /**
   * Optional already-started first round (runTurn sends the first request
   * itself); must have been built from `prepareSearchRequest(...)`.
   */
  firstRound?: AsyncIterable<CoreEvent>;
  signal: AbortSignal;
  logger?: CoreLogger;
  requestId?: string;
  /** Shared registry so encoders can resolve stable citation indices. */
  citations?: CitationRegistry;
}

/**
 * Request for one hosted-loop round: client function tools are kept on every
 * round next to the offered internal tools. `forced` names internal tools
 * forced by tool_choice; a forced-only choice of an internal tool that is no
 * longer offered falls back to the client's tools.
 */
export function prepareHostedRequest(
  req: CoreRequest,
  offered: readonly ToolDef[],
  internalNames: readonly string[],
  forced: readonly string[] = [],
): CoreRequest {
  const isOffered = (n: string) => offered.some((t) => t.name === n);
  const forcedOffered = forced.filter(isOffered);
  let toolMode: ToolMode = req.toolMode;
  if (forcedOffered.length) {
    toolMode = { kind: "required", only: forcedOffered };
  } else if (
    req.toolMode.kind === "required" &&
    (offered.length === 0 ||
      req.toolMode.only?.some(
        (n) => internalNames.includes(n) && !isOffered(n),
      ))
  ) {
    const only = req.toolMode.only?.filter(
      (n) => !internalNames.includes(n) || isOffered(n),
    );
    toolMode = only?.length
      ? { kind: "required", only }
      : req.tools.length
        ? { kind: "auto" }
        : { kind: "none" };
  } else if (req.toolMode.kind === "none" && offered.length) {
    // Client forbade its own tools; offer only the hosted tools.
    return { ...req, tools: [...offered], toolMode: { kind: "auto" } };
  }
  return { ...req, tools: [...req.tools, ...offered], toolMode };
}

/** Search-only form of {@link prepareHostedRequest}. */
export function prepareSearchRequest(
  req: CoreRequest,
  toolName: string,
  opts: { offerSearch: boolean; forceSearch: boolean },
): CoreRequest {
  return prepareHostedRequest(
    req,
    opts.offerSearch ? [internalSearchToolDef(toolName)] : [],
    [toolName],
    opts.forceSearch ? [toolName] : [],
  );
}

function addUsage(
  a: NormalizedUsage | undefined,
  b: NormalizedUsage | undefined,
): NormalizedUsage | undefined {
  if (!b) {
    return a;
  }
  if (!a) {
    return { ...b };
  }
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const out: NormalizedUsage = {
    input: a.input + b.input,
    output: a.output + b.output,
  };
  const cr = sum(a.cacheRead, b.cacheRead);
  const cw = sum(a.cacheWrite, b.cacheWrite);
  const rs = sum(a.reasoning, b.reasoning);
  if (cr !== undefined) {
    out.cacheRead = cr;
  }
  if (cw !== undefined) {
    out.cacheWrite = cw;
  }
  if (rs !== undefined) {
    out.reasoning = rs;
  }
  return out;
}

function queryOf(input: object): string {
  const q = (input as { query?: unknown }).query;
  return typeof q === "string" ? q.trim() : "";
}

export function formatResultsForModel(
  sources: readonly Source[],
  indices: readonly number[],
): string {
  if (!sources.length) {
    return "No results.";
  }
  return sources
    .map((s, i) => {
      const lines = [
        `[${indices[i] + 1}] ${s.title ?? s.url}`,
        `URL: ${s.url}`,
      ];
      if (s.publishedAt) {
        lines.push(`Published: ${s.publishedAt}`);
      }
      if (s.snippet) {
        lines.push(s.snippet);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

type HostedOutcome =
  | {
      kind: "search";
      call: ToolCallPart;
      query: string;
      sources: Source[];
      indices: number[];
      error?: HostedErrorCode;
    }
  | {
      kind: "fetch";
      call: ToolCallPart;
      url: string;
      sources: Source[];
      indices: number[];
      error?: HostedErrorCode;
      page?: FetchedPage;
    };

function urlOf(input: object): string {
  const u = (input as { url?: unknown }).url;
  return typeof u === "string" ? u.trim() : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const domainMatch = (host: string, d: string): boolean => {
  const dd = d.toLowerCase().replace(/^\*?\./, "");
  return host === dd || host.endsWith(`.${dd}`);
};

/** Text of every earlier user part: user messages and tool results. */
function priorContextText(turns: readonly Turn[]): string {
  const out: string[] = [];
  for (const t of turns) {
    if (t.role !== "user") {
      continue;
    }
    for (const p of t.parts) {
      if (p.type === "text") {
        out.push(p.text);
      } else if (p.type === "toolResult") {
        for (const c of p.content) {
          if (c.type === "text") {
            out.push(c.text);
          }
        }
      }
    }
  }
  return out.join("\n");
}

/**
 * Why a fetch must not run, or undefined. Like Anthropic's web_fetch, only
 * URLs already in the conversation (user text, tool results, earlier search
 * or fetch results) are fetched, so the model cannot send data to a URL it
 * made up; private and local hosts are never fetched.
 */
export function fetchRefusal(
  url: string,
  tool: HostedFetchTool,
  turns: readonly Turn[],
  citations: CitationRegistry,
): HostedErrorCode | undefined {
  if (!url || !/^https?:\/\//i.test(url)) {
    return "invalid_tool_input";
  }
  if (url.length > MAX_FETCH_URL_LENGTH) {
    return "url_too_long";
  }
  if (!checkUrl(url).safe) {
    return "url_not_allowed";
  }
  const host = hostOf(url);
  if (
    (tool.allowedDomains?.length &&
      !tool.allowedDomains.some((d) => domainMatch(host, d))) ||
    tool.blockedDomains?.some((d) => domainMatch(host, d))
  ) {
    return "url_not_allowed";
  }
  if (
    citations.indexOf(url) === undefined &&
    !priorContextText(turns).includes(url)
  ) {
    return "url_not_in_prior_context";
  }
  return undefined;
}

function resultText(r: HostedOutcome, searchBudgetCode: string): string {
  if (r.kind === "fetch") {
    if (r.error) {
      return `Fetch failed: ${r.error}.${r.error === "max_uses_exceeded" ? " No more fetches are available; answer with what you have." : ""}`;
    }
    const p = r.page as FetchedPage;
    return `[${r.indices[0] + 1}] ${p.title ?? p.url}\nURL: ${p.url}\n\n${p.text}`;
  }
  if (r.error) {
    return `Search failed: ${r.error}.${r.error === searchBudgetCode ? " No more searches are available; answer with what you have." : ""}`;
  }
  return formatResultsForModel(r.sources, r.indices);
}

function errorCodeOf(err: unknown): HostedErrorCode {
  if (err instanceof EngineError) {
    if (err.status === 429) {
      return "too_many_requests";
    }
    if (err.code === "missing_key") {
      return "unavailable";
    }
  }
  return "unavailable";
}

/**
 * Plain-text Sources list appended to the final answer: `[n] Title - URL`
 * in registry index order. Empty when no search returned sources.
 */
export function sourcesText(citations: CitationRegistry): string {
  const all = citations.all();
  if (!all.length) {
    return "";
  }
  const lines = all.map(
    (s, i) => `[${i + 1}] ${s.title?.trim() || s.url} - ${s.url}`,
  );
  return `\n\nSources:\n${lines.join("\n")}`;
}

/**
 * Runs the hosted search loop. Yields core events:
 * model text/thinking as they stream, one `hostedCall` + `hostedResult` pair
 * per internal search, client `toolCall`s, and exactly one final `end` with
 * usage summed over all rounds. When the model calls a client tool the turn
 * ends with reason `tool` after that call.
 */
export async function* runSearchLoop(
  o: SearchLoopOptions,
): AsyncGenerator<CoreEvent> {
  const log = createSafeLogger(o.logger, {
    requestId: o.requestId,
    protocol: o.req.protocol,
    engine: (o.engine ?? o.fetchEngine)?.meta.id,
  });
  const search =
    o.tool && o.engine ? { tool: o.tool, engine: o.engine } : undefined;
  const fetch =
    o.fetchTool && o.fetchEngine
      ? { tool: o.fetchTool, engine: o.fetchEngine }
      : undefined;
  const { searchName, fetchName } = internalToolNames(o.req.tools);
  const internalNames = [searchName, fetchName];
  const budget = computeBudget(
    o.maxSearchesPerRequest,
    search?.tool.maxUses,
    o.maxToolCalls,
  );
  const fetchBudget = computeBudget(
    o.maxSearchesPerRequest,
    fetch?.tool.maxUses,
    o.maxToolCalls,
  );
  const citations = o.citations ?? new CitationRegistry();
  const sem = new Semaphore(
    o.req.parallelToolCalls === false ? 1 : MAX_CONCURRENT_SEARCHES,
  );
  let used = 0;
  let fetched = 0;
  let usage: NormalizedUsage | undefined;
  let turns = [...o.req.turns];
  let pending = o.firstRound;

  const runFetch = async (call: ToolCallPart): Promise<HostedOutcome> => {
    const url = urlOf(call.input);
    const base = { kind: "fetch" as const, call, url, indices: [] };
    const refused = fetch
      ? fetchRefusal(url, fetch.tool, turns, citations)
      : "unavailable";
    if (refused || !fetch) {
      return { ...base, sources: [], error: refused ?? "unavailable" };
    }
    if (fetched >= fetchBudget.limit) {
      log.warn("hosted.budgetExceeded", {
        count: fetched,
        kind: "max_uses_exceeded",
      });
      return { ...base, sources: [], error: "max_uses_exceeded" };
    }
    fetched++;
    const started = Date.now();
    let result: FetchResult | undefined;
    try {
      result = (await sem.run(() => fetch.engine.fetch([url], o.signal)))[0];
    } catch {
      result = undefined;
    }
    log.info("hosted.fetch", {
      count: 1,
      resultCount: result?.status === "ok" ? 1 : 0,
      durationMs: Date.now() - started,
    });
    if (result?.status !== "ok" || !result.text) {
      return {
        ...base,
        sources: [],
        error:
          result?.status === "unsafe"
            ? "url_not_allowed"
            : "url_not_accessible",
      };
    }
    const page: FetchedPage = {
      url,
      text: capPage(result.text),
      retrievedAt: new Date().toISOString(),
    };
    if (result.title) {
      page.title = result.title;
    }
    const sources: Source[] = [
      result.title ? { url, title: result.title } : { url },
    ];
    return { ...base, sources, indices: citations.add(sources), page };
  };

  const runSearch = async (call: ToolCallPart): Promise<HostedOutcome> => {
    const query = queryOf(call.input);
    const base = { kind: "search" as const, call, query, indices: [] };
    if (!search || !query) {
      return { ...base, sources: [], error: "invalid_input" };
    }
    if (used >= budget.limit) {
      log.warn("hosted.budgetExceeded", { count: used, kind: budget.code });
      return { ...base, sources: [], error: budget.code };
    }
    used++;
    const started = Date.now();
    try {
      const results = await sem.run(() =>
        search.engine.search(
          query,
          {
            allowedDomains: search.tool.allowedDomains,
            blockedDomains: search.tool.blockedDomains,
          },
          o.signal,
        ),
      );
      const sources = results.map(toSource);
      const indices = citations.add(sources);
      log.info("hosted.search", {
        resultCount: sources.length,
        durationMs: Date.now() - started,
      });
      return { ...base, sources, indices };
    } catch (err) {
      const code = errorCodeOf(err);
      log.warn("hosted.error", {
        kind: code,
        durationMs: Date.now() - started,
      });
      return { ...base, sources: [], error: code };
    }
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (o.signal.aborted) {
      return;
    }
    const offered: ToolDef[] = [];
    if (search && used < budget.limit) {
      offered.push(internalSearchToolDef(searchName));
    }
    if (fetch && fetched < fetchBudget.limit) {
      offered.push(internalFetchToolDef(fetchName));
    }
    const forced =
      round === 0
        ? [
            ...(search?.tool.forced ? [searchName] : []),
            ...(fetch?.tool.forced ? [fetchName] : []),
          ]
        : [];
    const roundReq = prepareHostedRequest(
      { ...o.req, turns },
      offered,
      internalNames,
      forced,
    );
    const stream = pending ?? o.callModel(roundReq);
    pending = undefined;

    const internal: ToolCallPart[] = [];
    const client: ToolCallPart[] = [];
    const assistantParts: Part[] = [];
    let end: Extract<CoreEvent, { e: "end" }> | undefined;
    let text = "";

    for await (const ev of stream) {
      if (o.signal.aborted) {
        return;
      }
      switch (ev.e) {
        case "text":
          text += ev.delta;
          yield ev;
          break;
        case "thinking":
          assistantParts.push({
            type: "thinking",
            text: ev.delta,
            signature: ev.signature,
          });
          yield ev;
          break;
        case "toolCall":
          (internalNames.includes(ev.name) ? internal : client).push({
            type: "toolCall",
            id: ev.id,
            name: ev.name,
            input: ev.input,
          });
          break;
        case "end":
          end = ev;
          break;
        case "error":
          yield ev;
          return;
        default:
          yield ev;
      }
    }
    usage = addUsage(usage, end?.usage);
    if (text) {
      assistantParts.unshift({ type: "text", text });
    }

    // Execute internal searches and fetches (bounded by budget and semaphore).
    const outcomes = await Promise.all(
      internal.map((call) =>
        call.name === fetchName ? runFetch(call) : runSearch(call),
      ),
    );
    if (o.signal.aborted) {
      return;
    }
    for (const r of outcomes) {
      yield r.kind === "fetch"
        ? { e: "hostedCall", id: r.call.id, kind: "fetch", url: r.url }
        : { e: "hostedCall", id: r.call.id, kind: "search", query: r.query };
      const res: CoreEvent = {
        e: "hostedResult",
        callId: r.call.id,
        sources: r.error ? [] : r.sources,
      };
      if (r.error) {
        res.error = r.error;
      } else if (r.kind === "fetch" && r.page) {
        res.page = r.page;
      }
      yield res;
    }

    if (client.length) {
      // The turn ends with the client tool call; Sources come before it.
      const list = sourcesText(citations);
      if (list) {
        yield { e: "text", delta: list, sources: true };
      }
      for (const c of client) {
        yield { e: "toolCall", id: c.id, name: c.name, input: c.input };
      }
      yield { e: "end", reason: "tool", usage };
      return;
    }
    if (!internal.length) {
      const list = sourcesText(citations);
      if (list) {
        yield { e: "text", delta: list, sources: true };
      }
      yield end ? { ...end, usage } : { e: "end", reason: "stop", usage };
      return;
    }

    // Feed results back for the next round.
    const results: ToolResultPart[] = outcomes.map((r) => ({
      type: "toolResult",
      callId: r.call.id,
      name: r.call.name,
      isError: r.error !== undefined,
      content: [{ type: "text", text: resultText(r, budget.code) }],
    }));
    turns = [
      ...turns,
      { role: "assistant", parts: [...assistantParts, ...internal] },
      { role: "user", parts: results },
    ];
  }
  const list = sourcesText(citations);
  if (list) {
    yield { e: "text", delta: list, sources: true };
  }
  yield { e: "end", reason: "stop", usage };
}

/**
 * Hook that appends the Sources list for pages fetched before the model call
 * (Gemini urlContext): before the first client tool call, or before `end`.
 */
export function sourcesHook(citations: CitationRegistry): HostedHook {
  return {
    async *wrap(events) {
      let done = false;
      for await (const ev of events) {
        if (!done && (ev.e === "toolCall" || ev.e === "end")) {
          done = true;
          const list = sourcesText(citations);
          if (list) {
            yield { e: "text", delta: list, sources: true };
          }
        }
        yield ev;
      }
    },
  };
}
