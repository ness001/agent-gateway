# Agent Gateway

[![CI](https://github.com/ness001/agent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/ness001/agent-gateway/actions/workflows/ci.yml)

Use your GitHub Copilot models in the coding agents you already use: Claude
Code, Codex, Gemini CLI, Antigravity CLI, Kilo Code, Cline, DeepSeek Harness, Pi, Oh My Pi, Hermes, OpenClaw and
more. Agent Gateway
runs inside VS Code and gives them one local endpoint at
`http://127.0.0.1:24444`. You can also share your models with another machine,
and give agents web search and URL fetch.

## Features

- **One endpoint for every agent.** Speaks the OpenAI (Responses and Chat
  Completions), Anthropic Messages and Gemini APIs, so most agents work without
  changes.
- **One-click agent setup.** **Configure Coding Agents** writes each agent's
  settings for you, backs up every file first, and can undo its changes.
- **Share across machines.** Host the gateway through a dev tunnel, and add
  other machines' gateways as remote upstreams.
- **Web search and URL fetch.** Agents that use built-in web search (Claude
  Code, Codex, Gemini CLI) can search and read pages through Exa, Firecrawl,
  Tavily, Jina AI or You.com, several engines without an API key.
- **Easy troubleshooting.** A status view, a 7-day error log, and a request ID
  on every response and log line. Prompts and keys are never logged.

## Getting started

1. Install the extension. You need VS Code with GitHub Copilot Chat, signed in.
2. When VS Code asks whether Agent Gateway may use the Copilot language
   models, choose **Allow**. Without this, no models are served.
3. Click **Gateway** in the status bar (or run **Agent Gateway: Status**) and
   check that it says **Ready**.
4. Run **Agent Gateway: Configure Coding Agents**, pick your agents and a
   default model, review the changes and confirm.

The gateway runs while VS Code is open. To turn it off without uninstalling,
set `agentGateway.enabled` to `false`.

## Supported agents

| Agent                    | How it is configured                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code              | Points Claude Code at the gateway; models are discovered automatically. Also sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`, so auto mode uses Claude Code's own safety checks without a notice.                              |
| Codex                    | Adds an `agent-gateway` provider and makes it the default.                                                                                                                                                           |
| Gemini CLI               | Set `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:24444` (see [manual setup](docs/reference.md#manual-client-setup)). Google has moved personal accounts to Antigravity CLI; Gemini CLI still works here with an API key. |
| Antigravity CLI (`agy`)  | Switches agy to its Gemini API key mode, then shows the two environment variables to set. agy offers only Gemini model names, so the gateway needs a matching model or a model alias.                                |
| Oh My Pi (omp)           | Adds the gateway as a provider with automatic model discovery; pick a model with `/model`.                                                                                                                           |
| Pi                       | Adds the gateway with its model list; run **Configure Coding Agents** again after models change.                                                                                                                     |
| Hermes Agent             | Adds an `agent-gateway` provider; run `hermes --provider agent-gateway` or pick it in `hermes model`.                                                                                                                |
| OpenClaw                 | Adds the gateway with its model list. Checked against OpenClaw's documentation, not yet tested with a live install.                                                                                                  |
| Kilo Code                | Adds the gateway with its model list; pick `agent-gateway/<model>` with `/models`.                                                                                                                                   |
| Cline (CLI)              | Adds an OpenAI Compatible provider and makes it active; switch models with `cline -m <model>`. The Cline VS Code extension is set up by hand.                                                                        |
| DeepSeek Harness (`dsh`) | Adds the gateway with its model list and makes your chosen model the default; removing it restores the previous default.                                                                                             |
| Cursor                   | Shows manual steps. Cursor calls models from its own servers, so it needs a shared (dev tunnel) URL.                                                                                                                 |
| Any other agent          | Use the OpenAI, Anthropic or Gemini base URL; see [manual setup](docs/reference.md#manual-client-setup).                                                                                                             |

Each changed file is backed up next to itself as
`<file>.agent-gateway-<timestamp>.bak`. **Configure Coding Agents** >
**Remove gateway** reverts only what the gateway added.

## Models for sub-agents and background tasks

Some agents send extra requests under their own model names, not the model you
picked. These are the names each agent sent in our tests:

| Agent (version tested)                                | Model names sent besides your main model                                                    | Change them with                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.295                                   | `claude-haiku-5.5` and `claude-sonnet-5` (titles, summaries, helper and sub-agent requests) | `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` in the `env` of `~/.claude/settings.json` |
| Gemini CLI 0.32.1                                     | `gemini-3-flash-preview`                                                                    | Built in; see step 3 below                                                                                                                |
| Antigravity CLI 1.4.3                                 | `gemini-3.1-flash-lite-preview`                                                             | Built in; see step 3 below                                                                                                                |
| Oh My Pi 18.10.3                                      | `claude-haiku-5.5`                                                                          | omp's model roles                                                                                                                         |
| Codex, Pi, Hermes, Kilo Code, Cline, DeepSeek Harness | None: every request used your main model                                                    |                                                                                                                                           |

Everyone's Copilot model list is different. The gateway resolves each
requested name against your own list (**Status**, or `GET /v1/models`), in
this order:

1. Your list has a model with exactly that name: it is used.
2. `agentGateway.modelAliases` maps the name, for example
   `{"claude-sonnet-5": "claude-sonnet-5.5"}`: the target is used.
3. Gemini names that Gemini CLI and Antigravity CLI use internally
   (`gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`,
   `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`,
   `gemini-3-pro-preview`): the newest Gemini model in your list with "flash"
   (or "pro") in its name.
4. Any other name: the model in `agentGateway.fallbackModel`, else
   `gpt-6-astra` if your list has it, else the request fails. A Gemini request
   with an unknown name fails instead. Run **Set Fallback Model** to choose a
   local or remote upstream model; **Status** shows which fallback model is in use.

Every substitution is written to the **Agent Gateway** output panel, for
example `Model fallback: requested "gpt-5.5" -> using "gpt-6-astra"`, and sent
back in the `x-agent-gateway-model-fallback` response header. Agents change
these names between versions, so check the output panel after updating one.

## Server tools

Your agent's own tools (commands, file edits, MCP servers) run on your
machine and work unchanged.

Some tools normally run on the model provider's servers. Copilot models in VS
Code have no such servers, so the gateway runs what it can itself:

| Server tool                                                                                             | Through the gateway                                                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Web search (Anthropic `web_search`, OpenAI `web_search`, Gemini `googleSearch`)                         | Run by the gateway through the engine you pick in **Web Search and Fetch**. Off until you pick one.       |
| Gemini URL context (`urlContext`, Gemini CLI's `web_fetch`)                                             | Run by the gateway, unless the same request also has the agent's own tools.                               |
| Anthropic `web_fetch`                                                                                   | Run by the gateway with the same engine. Only pages whose URL is already in the conversation are fetched. |
| Code execution (Anthropic `code_execution`, OpenAI code interpreter, Gemini `codeExecution`)            | Not supported. Left out (Anthropic: the request fails).                                                   |
| OpenAI `file_search`, image generation, remote `mcp`, hosted `tool_search`; Gemini Maps and File Search | Not supported. Left out.                                                                                  |
| Other Anthropic server tools (MCP connector, tool search, advisor)                                      | Not supported. The request fails.                                                                         |

A tool that is left out is never shown to the model, and the **Agent Gateway**
output panel notes it. None of the agents in the table above sends an
unsupported server tool in our tests.

## Commands

All commands are under **Agent Gateway** in the Command Palette.

| Command                      | What it does                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Status                       | Shows the gateway state, models, remotes and recent errors, with quick actions.     |
| Restart Gateway              | Restarts the local gateway.                                                         |
| Change Port                  | Moves the gateway to another port and offers to update your agents.                 |
| Set Fallback Model           | Chooses which of your models answers when an agent asks for a model you don't have. |
| Configure Coding Agents      | Sets up, updates or removes the gateway in your agents.                             |
| Web Search and Fetch         | Chooses the web search engine and its API key.                                      |
| Share Gateway via Dev Tunnel | Shares your gateway with another machine and manages the gateway API key.           |
| Manage Remote Upstreams      | Adds, tests or removes another machine's gateway.                                   |

## Share models between machines

On the machine with Copilot, run **Share Gateway via Dev Tunnel**. It installs
and signs in to the `devtunnel` CLI if needed, offers to create a gateway API
key, and starts a tunnel whose URL stays the same across runs. Use **Copy client
setup** to send the URL (the key is never included).

On the other machine, run **Manage Remote Upstreams** > **Add remote
upstream**, paste the URL and enter the key. Its models appear as
`<name>--<model>`.

> Anyone with the tunnel URL and key can use your Copilot models. Always set a
> gateway API key before sharing.

## Web search and URL fetch

Web search is off until you turn it on. Run **Web Search and Fetch**, pick an
engine, and enter its API key, or leave the key empty to use the engine's
free anonymous endpoint where there is one.

| Engine    | Without a key                   |
| --------- | ------------------------------- |
| Exa       | Search and fetch (rate-limited) |
| Firecrawl | Search and fetch (rate-limited) |
| Jina AI   | Fetch only                      |
| Tavily    | Needs a key                     |
| You.com   | Needs a key                     |

Keys are stored in VS Code secret storage, never in `settings.json`. For Codex,
the command also offers to turn on its live search (`web_search = "live"`).
Search queries, results and page text are never logged.

### AI-assisted model mappings

Reopen **Set Fallback Model** to see **Mapping: &lt;requested ID&gt;** entries
with their current targets, including empty defaults and saved custom mappings.
Select a mapping to change its target or leave it empty, without running AI again.
This changes only that mapping, not the fallback model or unrelated mappings.

The mapping settings include `claude-haiku-5.5` and `claude-sonnet-5` by default,
with empty targets. No replacement is forced when a suitable model is unavailable.
An empty target means no explicit mapping; normal direct-model/fallback routing
still applies. AI suggestions can also leave a target empty.

Run **Set Fallback Model** > **Initialize model mappings with AI…** to suggest
which available local models should answer an agent's default model names.
Enter exact requested IDs, such as `claude-haiku-5.5` and `claude-sonnet-5`,
then choose a Copilot model to make recommendations. The default list is editable;
include alternate spellings explicitly when your agent uses them.

The advisor sees only those IDs and available model metadata, not your files or
conversation. This uses Copilot quota. It matches lightweight, balanced and
reasoning roles, but its suggestions are not measured performance rankings.
Only existing local targets compatible with Anthropic messages are accepted;
remote models and models known not to support tools are excluded.

Review the suggested pairs and reasons, then select which ones to save to
`agentGateway.modelAliases`. Existing mappings (including disabled entries) are
unchecked by default; select one explicitly to replace it. Unrelated mappings
and the fallback model remain unchanged. Canceling saves nothing. Settings apply
without a gateway restart; an existing workspace override is updated there,
otherwise the mappings are saved in user settings.

## Settings

| Setting                                        | Default | Description                                                        |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `agentGateway.enabled`                         | `true`  | Run the gateway.                                                   |
| `agentGateway.port`                            | `24444` | Local port. Use **Change Port** to change it safely.               |
| `agentGateway.logLevel`                        | `info`  | `error`, `warn`, `info` or `debug`.                                |
| `agentGateway.remoteUpstreams`                 | `[]`    | Other machines' gateways (managed by **Manage Remote Upstreams**). |
| `agentGateway.webSearch.provider`              | `none`  | Web search engine (managed by **Web Search and Fetch**).           |
| `agentGateway.webSearch.maxSearchesPerRequest` | `5`     | Most searches per request (1-20).                                  |
| `agentGateway.webSearch.model`                 | `""`    | Model for Gemini CLI search requests when its model is unknown.    |
| `agentGateway.modelAliases`                    | `{}`    | Map a requested model name to one of your models.                  |
| `agentGateway.fallbackModel`                   | `""`    | Model for unknown model names (managed by **Set Fallback Model**). |

## Troubleshooting

- **Status shows Waiting for Copilot:** make sure Copilot Chat is signed in and
  that you allowed Agent Gateway to use the language models.
- **Port in use:** another program has port 24444. The gateway keeps retrying;
  use **Change Port** to pick another one.
- **A request failed:** every response has a `request-id` (and
  `x-request-id`) header. Find that
  ID in **Status** > **Open error log** or in the **Agent Gateway** output
  panel. Set `agentGateway.logLevel` to `debug` for more detail.
- **An agent stopped working after changing the port:** run **Configure Coding
  Agents** again.

### Known issues

- **Codex browser/computer-use tools report "Codex auth token is unavailable":**
  this is expected when the Codex browser connector cannot obtain its required
  auth token, including gateway-only sessions without a Codex sign-in. Model
  requests can still work through Agent Gateway: the browser connector uses a
  separate authentication path, even though it controls a local browser.
  Agent Gateway does not supply or inject that token. Check your sign-in in
  Codex and retry; if already signed in, investigate Codex's connector/auth state.
  See [Codex authentication](https://developers.openai.com/codex/auth).
  This error alone does not mean Playwright or `agent-browser` is unavailable;
  those use separate connections. It is not a gateway model-request failure.
- **Antigravity CLI fails with "invalid stream chunk: : ping":** during a long
  pause the gateway sends a standard keep-alive line on the stream, and
  Antigravity CLI 1.4.3 does not accept it. Other agents are not affected.
  Retry the request.
- **Claude Code says auto mode "isn't eligible" for no-charge classifier
  requests:** auto mode's server-side checks need Anthropic's own API, so
  through the gateway Claude Code runs its own checks, on your Copilot model.
  Nothing breaks. Run **Configure Coding Agents** again to set
  `CLAUDE_CODE_AUTO_MODE_SERVER=0`, which hides the notice.

## Privacy and security

- The gateway listens on your computer only (loopback). Nothing is reachable
  from other machines unless you share it through a dev tunnel.
- Prompts, request bodies, tool arguments, search queries and API keys are
  never logged.
- API keys are kept in VS Code secret storage.

## More information

- [Reference](docs/reference.md): API endpoints, manual client setup, how web
  search and model fallback work, logs.
- [Contributing](CONTRIBUTING.md): building, testing and the project's design.
- [Changelog](CHANGELOG.md).

## License

[MIT](LICENSE)
