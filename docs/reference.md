# Reference

Technical details for users who configure agents by hand or want to know how
the gateway behaves. For everyday use, see the [README](../README.md).

## Endpoints

The gateway listens on `http://127.0.0.1:24444` (loopback only; change it with
**Change Port**). Development builds use `24445`.

| API                     | Path                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| OpenAI Responses        | `POST /v1/responses`                                                                    |
| OpenAI Chat Completions | `POST /v1/chat/completions`                                                             |
| Anthropic Messages      | `POST /v1/messages`, `POST /v1/messages/count_tokens`                                   |
| Gemini                  | `POST /v1beta/models/<model>:generateContent`, `:streamGenerateContent`, `:countTokens` |
| Model list              | `GET /v1/models`                                                                        |
| Health                  | `GET /health`                                                                           |

Streaming, tool calls, reasoning, images and token usage are supported on every
API. OpenAI Responses also accepts Codex's `namespace`, freeform `custom`,
client `tool_search` and `additional_tools` inputs. Built-in tools that cannot
run through VS Code (for example `file_search` or code interpreter) are dropped
with an info line in the output log.

Inline base64 and data-URL images have no size limit; the image type is
detected from the bytes. Image links (OpenAI `image_url` and `input_image`
with an http(s) URL, Anthropic `url` image sources) are downloaded by the
gateway and passed as images:

- http(s) only; loopback, private, link-local, single-label and `.local`
  hosts and URLs with credentials are refused, also as redirect targets
- at most 3 redirects, 30 s per image, all images downloaded in parallel
- no cookies or credentials are sent
- the bytes must be a JPEG, PNG, GIF, WebP or BMP image
- a 50 MB safety cap per downloaded image protects the extension host

If a download fails, the model gets a short text description of the image
part instead. File IDs, Gemini file references, documents and audio are
always passed as that text description (type, URL or file ID, MIME type and
file name); inline file data is left out. Request bodies have no size limit.

Copilot ignores `temperature`, `top_p` and stop sequences; the gateway accepts
them and logs that they were ignored. Output limits are forwarded only when the
client sends one.

## Manual client setup

**Configure Coding Agents** covers the agents listed in the README. For any
other client use one of these base URLs:

- Anthropic Messages: `http://127.0.0.1:24444` (for example
  `ANTHROPIC_BASE_URL`).
- OpenAI Responses and Chat Completions: `http://127.0.0.1:24444/v1`.
- Gemini: `http://127.0.0.1:24444/v1beta` when the client appends `/models`, or
  `http://127.0.0.1:24444/` when the SDK appends `v1beta` (Gemini CLI:
  `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:24444`, `GEMINI_API_KEY` any value,
  and `security.auth.selectedType = "gemini-api-key"` in
  `~/.gemini/settings.json`).

If a client requires a key and no gateway API key is set, use any placeholder
such as `local-gateway`. Once a gateway API key is set (needed for sharing), the
client must send it as a bearer token, `x-api-key` or `x-goog-api-key`.

### Files written by Configure Coding Agents

Gemini CLI setup writes the gateway URL, key and selected model in `~/.gemini/.env`,
selects API-key authentication in `~/.gemini/settings.json`, and records prior
values in `~/.gemini/agent-gateway.json` for undo. `GEMINI_CLI_HOME` overrides the
home directory. Existing process variables, a nearer project `.env`, workspace
settings or `--model` can take precedence. Restart Gemini CLI after configuring.
This adapter has focused configuration tests but is not yet verified live.

| Agent            | File                                                                                                                            | Models             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Codex            | `~/.codex/config.toml`                                                                                                          | discovered         |
| Claude Code      | `~/.claude/settings.json`                                                                                                       | discovered         |
| Oh My Pi (omp)   | `~/.omp/agent/models.yml`                                                                                                       | discovered         |
| Pi               | `~/.pi/agent/models.json`                                                                                                       | written list       |
| Hermes Agent     | `%LOCALAPPDATA%\hermes\config.yaml` on Windows, else `~/.hermes/config.yaml` (`HERMES_HOME` wins)                               | discovered         |
| OpenClaw         | `~/.openclaw/openclaw.json`                                                                                                     | written list       |
| Kilo Code        | `~/.config/kilo/kilo.jsonc` (or `kilo.json` when that is the only file)                                                         | written list       |
| Cline (CLI)      | `~/.cline/data/settings/providers.json`                                                                                         | default model only |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml` (`DSH_HOME` wins), applies to every dsh profile                                                       | written list       |
| Antigravity CLI  | `~/.gemini/antigravity-cli/settings.json` (`modelProvider` only; `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` are set by hand) | Gemini names only  |

OpenClaw support was checked against OpenClaw's public documentation and
source, not a live install.

Each changed file is backed up next to itself as
`<file>.agent-gateway-<YYYYMMDDHHmmss>.bak`. Removing the gateway reverts only
its own entries.

Codex configuration sets `model_catalog_url` inside
`[model_providers.agent-gateway]` to the gateway's `/v1/models` endpoint and
enables `features.api_key_model_discovery`. On macOS only, it also enables
`features.respect_system_proxy`, so Codex's native resolver honors the system
proxy exception list without changing proxy environment variables. Existing
managed feature values and the provider's catalog URL are recorded for
restoration; unrelated features remain unchanged. Restart Codex after configuring.

### Context-window configuration

Configure Coding Agents copies valid positive integer context capacities from the
gateway model metadata, not from model names or output-token limits.

| Agent | Context configuration |
| --- | --- |
| Claude Code | Selected model: `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` |
| Codex | Selected model: `model_context_window` |
| Pi, OpenClaw, DeepSeek Harness | Per-model `contextWindow` in their existing model lists |
| Kilo | Per-model `limit.context`, even when output metadata is unavailable |
| Hermes | Per-model `providers.agent-gateway.models.<id>.context_length`; a user-pinned global context setting may take precedence |
| Oh My Pi | Existing model discovery reads gateway metadata; no static override is written |
| Cline CLI, Cursor, Antigravity | No verified context-setting support in these adapters; no override is written |

Claude Code and Codex replace the existing context override and record it for
restoration on unconfigure, including upgrades of older gateway configurations.
Reconfigure after changing models: their context overrides are session-wide,
not a dynamic per-request selection. Missing or invalid metadata is never guessed;
any previously managed context override is restored rather than left stale.
Context metadata does not determine output budgets. Compaction-percentage settings
are unchanged; Claude Code uses the separate output policy described below.

## Models

`GET /v1/models` lists your Copilot models, remote models as
`<remote>--<model>`, and `gateway-claude-<model>` aliases that let Claude Code
show every model. **Configure Coding Agents** writes the selected model's
`gateway-claude-` alias to Claude Code's `ANTHROPIC_MODEL` setting; other
clients keep the selected model ID. Existing aliases are not prefixed again.

For Claude Code, configuration always sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
to `128000`, overriding an existing value. The original value is saved for
restoration when removing the gateway. This is a requested output budget, not a
guarantee that every upstream model supports it. Models with smaller limits may
require a lower value after configuration; rerunning Configure resets it to
`128000`. Context size is never used as the output limit.

### Unknown models and aliases

A request for an unknown model falls back to the fallback model (logged as a
warning and reported in the `x-agent-gateway-model-fallback` header). The
fallback model is `agentGateway.fallbackModel` if it names an available local
or remote model that supports the requested API; otherwise the request fails.
No model is selected automatically. Use **Set Fallback Model** to choose one,
or **No fallback** to disable it. Remote IDs use `{name}--{modelId}`.
A setting that names a missing or incompatible model logs a warning; it does
not select a different model. Errors from an existing model do not trigger fallback.
Gemini requests do not fall back, except through aliases. **Status** and `/health`
(`fallbackModel`) show the model in use.

`agentGateway.modelMappings` maps a requested name to one of your models for
every API, for example `{"my-model": "gpt-5.6-sol"}`. Built-in aliases cover
Gemini CLI's internal model names (`gemini-3-flash-preview`,
`gemini-2.5-flash`, `gemini-2.5-flash-lite` and Antigravity CLI's
`gemini-3.1-flash-lite-preview` go to your best Gemini Flash model;
`gemini-3-pro-preview` and `gemini-2.5-pro` to your best Gemini Pro model;
without a Gemini model, the fallback model). An
empty string disables a built-in alias. Aliased names are not listed in
`/v1/models`.

## Web search and URL fetch

### Which agents use it

| Agent                     | How it searches                                                  | Gateway handling                           |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Codex                     | Responses `web_search` tool                                      | Hosted search; needs `web_search = "live"` |
| Claude Code               | `WebSearch` sends a side request with `web_search_YYYYMMDD`      | Hosted search                              |
| Gemini CLI                | `google_web_search` (`googleSearch`), `web_fetch` (`urlContext`) | Hosted search and fetch                    |
| omp, Pi, Hermes, OpenClaw | Their own client-side tools                                      | Passed through                             |

The agent's own tools stay available while the gateway searches, so a model
can search and then call a tool (for example write a file) in the same turn.

### Engines

| Engine    | Search without a key             | Fetch endpoint                        | Fetch without a key  | Key header              |
| --------- | -------------------------------- | ------------------------------------- | -------------------- | ----------------------- |
| Exa       | Works (public MCP, rate-limited) | MCP `web_fetch_exa`; REST `/contents` | Works                | `x-api-key`             |
| Firecrawl | Works (rate-limited)             | `/v2/scrape`                          | Works (rate-limited) | `Authorization: Bearer` |
| Tavily    | Needs a key                      | `/extract`                            | Needs a key          | `Authorization: Bearer` |
| Jina AI   | Needs a key                      | Reader `r.jina.ai`                    | Works (rate-limited) | `Authorization: Bearer` |
| You.com   | Needs a key                      | `/v1/contents`                        | Needs a key          | `X-API-Key`             |

Anonymous availability was checked in October 2026 and can change at the
provider's discretion.

### Limits

- Searches per request: `agentGateway.webSearch.maxSearchesPerRequest`
  (default 5, 1-20), lowered by Anthropic `max_uses` or Responses
  `max_tool_calls`. Calls past the budget get a limit error and the model
  answers with what it has.
- Up to 4 searches run at once (1 with Responses `parallel_tool_calls: false`).
  A failed search returns an error result and the loop continues.
- URL fetch (Gemini `urlContext`): at most 5 URLs from the last user message,
  100,000 characters per page (then `[content truncated]`), 30 s per fetch,
  http(s) only. Loopback, private, link-local, single-label, `.local` hosts and
  URLs with credentials are never fetched and are reported `_UNSAFE`.
- Anthropic `web_fetch`: the model calls it like a tool and the gateway
  fetches the page with the configured engine. As with Anthropic's own tool,
  only URLs that already appear in the conversation (user messages, tool
  results, earlier search or fetch results) are fetched; others return
  `url_not_in_prior_context`. URLs over 250 characters, private and local
  hosts, and hosts outside `allowed_domains` or in `blocked_domains` are
  refused. Fetches count against the same per-request limit as searches
  (or `max_uses`), and `usage.server_tool_use.web_fetch_requests` counts
  the successful ones. Pages come back as a text document, capped at 100,000
  characters.
- With no engine configured, an optional search tool is dropped; a forced one
  returns 400 `tool_unavailable`. Gemini requests whose only tools are search
  return 400 `FAILED_PRECONDITION`.

### Results

- Anthropic: `server_tool_use` and `web_search_tool_result` blocks, citations,
  and `usage.server_tool_use.web_search_requests`; for fetches,
  `web_fetch_tool_result` blocks and `web_fetch_requests`.
- Responses: one `web_search_call` item per search and `url_citation`
  annotations.
- Gemini: `groundingMetadata` (queries, deduplicated sources, citation spans)
  and `urlContextMetadata` for fetched pages.

After a search or URL fetch, a `Sources:` list with one `[n] Title - URL`
line per source, in citation order, is added to the answer text. When the
turn ends with a client tool call, the list comes as text before the call.
Nothing is added when no search or fetch returned sources.

`agentGateway.webSearch.model` chooses the model for Gemini CLI's search side
requests when its internal model name is unknown; empty uses the aliases.

## Logs and request IDs

Every response has `request-id` and `x-request-id` headers with the same
value, and error bodies carry it as `request_id`. The gateway creates IDs like
`req_<24 characters>`. A caller-supplied `request-id`, `x-request-id` or
`X-Client-Request-Id` (letters, digits, `.`, `_`, `:`, `-`, up to 64
characters) is reused, and requests forwarded to a remote gateway keep the
same ID.

Error statuses follow each API: 400 invalid request, 403 model access not
allowed, 404 unknown model, 429 rate limited (with `Retry-After` when Copilot
gives a wait time), 502 other Copilot failures, 504 timeout. When Copilot
reports it is overloaded, Anthropic clients get 529 `overloaded_error` and
OpenAI and Gemini clients get 503 (`service_unavailable_error` /
`UNAVAILABLE`).

- **Output panel "Agent Gateway"**: one line per request
  (`[<id>] <protocol> <method> <path> model=... status=... <ms>`), one line
  with the settings sent to the model (output limit, reasoning, tool count,
  whether a cache key was present), warnings for repaired tool-call history,
  fallbacks and client disconnects. Remote settings and summaries start with
  `[remote][<upstream-name>]`. Settings describe forwarded metadata, not what
  the remote model applied; no prompt, stop text or cache-key value is included.
  `debug` adds provider error messages.
- **Status** > **Change log level**: select `error`, `warn`, `info`, or `debug`.
  Applies immediately without restarting; updates an existing workspace override,
  otherwise your user setting. For debug output, also select Debug for the
  Agent Gateway output channel in VS Code if its log filter hides those messages.
- **Error log** (**Status** > **Open error log**): one JSON line per failed
  request, kept for 7 days.
- **Status** > **Copy health details**: the `/health` snapshot with recent
  errors.

Prompts, request bodies, tool arguments, search queries, URLs, page text and
credentials are never logged.

## Remote upstreams

A remote upstream is another machine's Agent Gateway, usually reached through a
dev tunnel. It is probed with `GET /v1/gateway/catalog` before it is saved; its
models are listed as `<name>--<model>` and requests are forwarded with the
remote's API key. A remote that is down is skipped and local models keep
working.
