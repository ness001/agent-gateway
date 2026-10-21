# Changelog

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
