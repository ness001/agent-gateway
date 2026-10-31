# Changelog

## 0.1.7

- Simplify the Status panel: hide recent errors (use Open error log) and
  move the API URLs into a separate API URLs picker.
- Report a prompt that exceeds the model's context window with the OpenAI
  `context_length_exceeded` code and a hint to compact or shorten it.
- Report exhausted Copilot credits as a 429 quota error instead of a 500
  internal error.

## 0.1.6

- Fix "input_schema does not support oneOf, allOf, or anyOf at the top level"
  errors from newer Codex tools. The gateway merges top-level schema variants
  into one object schema, including for requests forwarded to remote gateways
  that run an older version.
- Add Brave Search and Kagi as web search providers.
- Log Codex automation heartbeats without call IDs at debug level.

## 0.1.5

- Enable Codex gateway model discovery and, on macOS, its native system proxy
  resolver so local catalog requests honor system proxy exceptions. Restore
  previous managed feature settings when removing the gateway.

## 0.1.4

- Start and manage dev tunnel sharing directly from **Status**.
- Automatically check the public connection after starting a tunnel; show
  **Connecting**, **Connected** with the model count, or a clear failure reason.
- Click **Models** in **Status** to search discovered local and remote models
  and copy a model ID. The count includes both local and remote models.
- Add a product landing page linked from the README and repository homepage.

## 0.1.3

- Choose local or remote upstream models in **Set Fallback Model**. No model is
  selected automatically; **No fallback** disables fallback. Unknown model names
  use only the selected model. Existing model errors do not trigger fallback.
- Allow slow first output without treating it as an actual request timeout.
- Automatically configure Gemini CLI with a gateway endpoint, key and model,
  with backups and reversible settings changes.
- Identify forwarded requests with `[remote][upstream-name]` and show safe
  generation settings alongside local request logs.
- Host dev tunnels in an extension-managed background process instead of an
  integrated terminal; stop hosting through **Stop sharing**.
- Copy API URLs, including token-count endpoints, directly from **Status**.
- Rename the model mapping setting to `agentGateway.modelMappings`. Rename any
  existing `agentGateway.modelAliases` setting to keep your mappings.

## 0.1.2

- Add AI-assisted model mapping initialization and manual editing in **Set
  Fallback Model**, including empty Haiku/Sonnet defaults and review before save.
- Add **Status > Change log level**, applied without restarting the gateway.
- Configure Claude Code with gateway model aliases and a 128,000-token output
  budget; configure agent context windows from available model metadata.
- Pass Copilot's advertised input budget on every model request to avoid
  unintended history trimming at a smaller default context size.
- Recover pre-output missing-tool-call rejections once without re-running tools,
  and preserve resumed tool results that have no call IDs.
- Normalize parallel Anthropic tool history without false reorder warnings;
  retain diagnostics for missing, orphaned, duplicate and late results.
- Document the separate authentication requirement for Codex browser tools.

## 0.1.1

- **Configure Coding Agents** pre-selects only agents already set up for the
  gateway; other installed agents start unselected.
- The confirmation dialog lists only the agents that will change; details
  are in **Show diff** and in the report shown after applying.
- **Show diff** no longer covers the diff with the confirmation dialog; apply
  or cancel from a picker that stays open while the diffs stay scrollable.

## 0.1.0

First release.

- Use your GitHub Copilot models from Claude Code, Codex, Gemini CLI, Antigravity CLI, Kilo Code,
  Cline, DeepSeek Harness, Pi, Oh My Pi, Hermes Agent, OpenClaw and other agents through one local endpoint.
  Supports the OpenAI (Responses and Chat Completions), Anthropic Messages and
  Gemini APIs, with streaming, tools, reasoning and images.
- **Configure Coding Agents** sets up, updates or removes the gateway in your
  agents, with a backup of every file it changes.
- **Change Port** moves the gateway and offers to update your agents.
- **Share Gateway via Dev Tunnel** and **Manage Remote Upstreams** let you use
  one machine's Copilot models from another machine, protected by an API key.
- **Web Search and Fetch**: built-in web search and URL fetch for Claude Code,
  Codex and Gemini CLI through Exa, Firecrawl, Tavily, Jina AI or You.com, some
  without an API key.
- **Set Fallback Model** (`agentGateway.fallbackModel`) chooses the model used
  for model names you don't have; built-in aliases cover the internal Gemini
  names used by Gemini CLI and Antigravity CLI.
- Image links in requests are downloaded and passed to the model; requests and
  inline images have no size limit. Anthropic's `web_fetch` tool is run by the
  gateway with your web search engine. After a web search, a `Sources:` list is
  added to the answer.
- Model aliases, a status view, a 7-day error log, and `request-id` /
  `x-request-id` headers on every response. Errors use each API's own status
  codes and types (including 429 with `Retry-After` and Anthropic's 529
  overload). Prompts and keys are never logged.
