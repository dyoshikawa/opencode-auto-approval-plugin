# opencode-auto-approval-plugin

An [OpenCode](https://opencode.ai/) plugin that sends tool operations to a read-only AI reviewer
before automatically approving them.

The reviewer is one of three backends:

| `reviewer.backend` | How it reviews                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent` (default)  | An LLM in its own OpenCode session (or, with an [agent runtime](#agent-runtimes), in Claude Code or Codex). It may inspect the workspace with `read`, `glob`, `grep`, and `lsp`, but cannot edit files, run shell commands, access the network, use MCP tools, or start subagents. |
| `chat`             | An LLM asked once through the OpenAI or Anthropic API, or any OpenAI-compatible Chat Completions API — OpenRouter, Workers AI, a local server — with the same prompt as the agent but no session and no tools.                                                                     |
| `decision`         | A [decision model](#decision-backend) over HTTP — TypeSafe AI's Jev or Cloudflare's Clef — that picks `allow`, `deny` or `escalate` with calibrated probabilities in one call.                                                                                                     |

Names used by earlier versions keep working; see [deprecated names](#deprecated-names).

## Supported OpenCode versions

The package ships both plugin API generations in one default export, so the same version works on:

| OpenCode      | Plugin API                             | Config key |
| ------------- | -------------------------------------- | ---------- |
| 2.x           | V2 (`@opencode/plugin`, `setup()`)     | `plugins`  |
| 1.18.29 – 1.x | V1 (`@opencode-ai/plugin`, `server()`) | `plugin`   |

OpenCode releases before 1.18.29 only accept a bare function as the plugin export and cannot load
this package; use `opencode-auto-approval-plugin@0.1.x` there.

## Install

OpenCode installs npm plugins listed in its configuration automatically. Add the package to the
project or global OpenCode configuration.

OpenCode 2.x (`opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-auto-approval-plugin"],
}
```

OpenCode 1.x:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-auto-approval-plugin"],
}
```

For local development, build the package and place it under `.opencode/plugins/` (2.x) or
`.opencode/plugin/` (1.x), or link the package through an npm workspace. OpenCode also loads
TypeScript files placed directly in those directories.

## Configuration

The defaults are `mode: "on-ask"`, a 30-second review timeout, the provider/model of the main
session, and no [custom review instructions](#custom-review-instructions).

OpenCode 2.x passes options through a `{ "package", "options" }` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "on-ask",
        "reviewer": {
          "timeoutMs": 30000,
        },
      },
    },
  ],
}
```

OpenCode 1.x uses a plugin tuple instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-auto-approval-plugin",
      {
        "mode": "on-ask",
        "reviewer": {
          "timeoutMs": 30000,
        },
      },
    ],
  ],
}
```

Set `reviewer.agent.model` to run reviews through a separately configured OpenCode provider and
model. With the default `agent` backend the plugin never reads or manages API keys; authentication
remains entirely in OpenCode.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "all-tools",
        "reviewer": {
          "agent": {
            "model": {
              "providerID": "openrouter",
              "modelID": "openai/gpt-5.6-luna",
            },
          },
          "timeoutMs": 15000,
        },
      },
    },
  ],
}
```

### Reviewer session lifecycle (OpenCode V2)

On V2, reviewer sessions are linked to their originating session instead of
cluttering the top-level session list. The reviewer transcript remains available
by default for auditing the decision.

Set `reviewer.agent.cleanupSessions: true` to delete reviewer sessions after a
decision. Deletion is best-effort and **never delays** the verdict or timeout.
This applies only to the OpenCode V2 agent runtime: setting it at all with the
Claude/Codex SDK runtimes (even to `false`), or setting it to `true` on OpenCode 1.x,
is rejected at startup, since it would have no effect there.

```json
{
  "reviewer": {
    "agent": {
      "cleanupSessions": true
    }
  }
}
```

### Agent runtimes

`reviewer.agent.runtime` chooses where the `agent` reviewer runs. It applies wherever the agent
reviewer does, including the decision backend's `onOversize: "agent"` fallback.

| `reviewer.agent.runtime` | Where the review runs                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `"opencode"` (default)   | A read-only OpenCode session, as described above                                               |
| `"claude-agent-sdk"`     | Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) |
| `"codex-sdk"`            | Codex through the [Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript)        |

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "reviewer": {
          "agent": {
            "runtime": "claude-agent-sdk",
            "model": "claude-haiku-5-5",
            "claudeAgentSdk": {
              "path": "/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk",
            },
          },
        },
      },
    },
  ],
}
```

- The SDKs are optional peer dependencies, and OpenCode does not install them with the plugin.
  Install the one you use (`npm install -g @anthropic-ai/claude-agent-sdk` or
  `npm install -g @openai/codex-sdk`) and point `reviewer.agent.claudeAgentSdk.path` or
  `reviewer.agent.codexSdk.path` at the installed package directory (under `npm root -g`); the
  path must be absolute. Without a path the plugin imports the SDK from where it is installed
  itself, which works when you install the plugin from your own `package.json`.
- `reviewer.agent.model` is a model name for these runtimes (`"claude-haiku-5-5"`,
  `"gpt-5.6-codex"`); unset, Claude Code or Codex uses its own default. Authentication is theirs
  too: a `claude` or `codex` sign-in, or `ANTHROPIC_API_KEY` / `CODEX_API_KEY` in the environment
  of the process that loads the plugin. The plugin never reads those keys.
- Neither can ask anyone for permission, since nobody is there to answer a prompt:
  - Claude Code gets only its `Read`, `Glob` and `Grep` tools, `permissionMode: "auto"`, and no
    settings from disk — no CLAUDE.md, hooks, MCP servers, plugins or permission rules from you or
    the project. A call auto mode cannot decide is denied.
  - Codex inspects the workspace through shell commands, so it runs in the `read-only` sandbox
    without network access or web search, with `approval_policy = "never"` so that no request
    can lift the sandbox (a command the sandbox blocks fails), and without the project's
    `AGENTS.md` or `.codex/config.toml`: the review marks the project directory and every
    directory above it as untrusted — and, when the project path goes through a symlink, its
    resolved path and the directories above that too — so the project's `.codex/config.toml`
    cannot add MCP servers or change any other setting even when you trusted the project in
    Codex. This override was verified on Linux and macOS paths only; on Windows, Codex's
    matching of drive letters, separators and UNC paths was not tested. Your own
    Codex config (`$CODEX_HOME/config.toml`, `~/.codex/config.toml` by default) and any
    system-managed config still load, MCP servers included. With
    `reviewer.agent.codexSdk.path` or an installed copy, the SDK must be 0.163.0 or newer (a
    prerelease of 0.163.0 is refused). The CommonJS build cannot locate an installed copy's
    version, so it needs `reviewer.agent.codexSdk.path`.
- Both can read files outside the project: Claude Code when its auto-mode classifier judges the
  read safe (measured on 2026-10-17, it read `/etc/hostname` and searched `/home` when asked to),
  Codex because its read-only sandbox can read the whole disk. What it reads reaches the model
  provider and, cut to 300 characters, the verdict reason. Use the `"opencode"` runtime if that is
  not acceptable.
- Reviews run in Claude Code or Codex, not in OpenCode, so they are not in `opencode stats`; they
  go to the [usage log](#usage-and-cost-statistics) instead (`claude-agent-sdk` with Claude
  Code's own cost estimate, `codex-sdk` without a price). Measured on 2026-10-17, a Claude Code
  review on `claude-haiku-5-5` took about 4 seconds and $0.001.

### Decision backend

Set `reviewer.backend` to `"decision"` to have a decision model judge each operation instead of an
OpenCode session. The plugin sends one request with the operation (`source`, `action`,
`resource`, the user's latest prompt and, when enabled, the bounded conversation) and a single `allow` / `deny` / `escalate` choice. No
reviewer agent or session is created (unless `onOversize` is `"agent"`) and the workspace is not
inspected. Two providers speak the
same System One API:

| Provider     | Models                                                                                                  | Credentials (option / environment)                                       | Default model |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| `typesafe`   | [TypeSafe AI](https://typesafe.ai/)'s Jev (`jev-latest`, `jev-1.14.0`, …)                               | `apiKey` / `TYPESAFE_API_KEY`, optional `baseURL` / `TYPESAFE_BASE_URL`  | `jev-latest`  |
| `cloudflare` | [Cloudflare](https://developers.cloudflare.com/workers-ai/)'s Clef on Workers AI (`clef`, `clef-flash`) | `apiKey` / `CLOUDFLARE_API_TOKEN`, `accountId` / `CLOUDFLARE_ACCOUNT_ID` | `clef`        |

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "on-ask",
        "reviewer": {
          "backend": "decision",
          "timeoutMs": 10000,
          "decision": {
            "provider": "cloudflare", // or "typesafe"
            "model": "clef",
            "minAllowProbability": 0.6,
          },
        },
      },
    },
  ],
}
```

| Option                                  | Default                   | Description                                                                                                                                             |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewer.backend`                      | `"agent"`                 | `"agent"`, `"chat"` or `"decision"`                                                                                                                     |
| `reviewer.decision.provider`            | — (required)              | `"typesafe"` or `"cloudflare"`                                                                                                                          |
| `reviewer.decision.apiKey`              | from the environment      | TypeSafe AI API key, or a Cloudflare API token with Workers AI access                                                                                   |
| `reviewer.decision.baseURL`             | `https://api.typesafe.ai` | `typesafe` only: API origin; a bare HTTPS origin (HTTP only for loopback)                                                                               |
| `reviewer.decision.accountId`           | from the environment      | `cloudflare` only: the 32-character account ID                                                                                                          |
| `reviewer.decision.model`               | per provider (above)      | Model or alias; pin a version such as `jev-1.14.0` for stable behavior                                                                                  |
| `reviewer.decision.minAllowProbability` | `0.6`                     | An `allow` answered with a lower probability becomes `escalate`                                                                                         |
| `reviewer.decision.maxStateTokens`      | `28000`                   | Estimated size above which an operation is too large to send (1,000–60,000)                                                                             |
| `reviewer.decision.longContext`         | off                       | `typesafe` only: `true` or `{ maxStateTokens, minAllowProbability }` to send larger operations with [long context](#long-context-typesafe)              |
| `reviewer.decision.onOversize`          | `"escalate"`              | Too large: `"escalate"` to a human, or hand it to the `"agent"` or `"chat"` reviewer                                                                    |
| `reviewer.agent.maxInputBytes`          | `200000`                  | The agent reviewer escalates a prompt longer than this (UTF-8 bytes) unsent rather than let the session compact it                                      |
| `reviewer.agent.runtime`                | `"opencode"`              | Where the agent reviewer runs: `"opencode"`, `"claude-agent-sdk"` or `"codex-sdk"` ([agent runtimes](#agent-runtimes))                                  |
| `reviewer.agent.cleanupSessions`        | `false`                   | `opencode` runtime on OpenCode 2.x only: delete each reviewer session after its decision ([session lifecycle](#reviewer-session-lifecycle-opencode-v2)) |
| `reviewer.agent.claudeAgentSdk.path`    | —                         | `claude-agent-sdk` only: absolute path of the installed `@anthropic-ai/claude-agent-sdk` package directory                                              |
| `reviewer.agent.codexSdk.path`          | —                         | `codex-sdk` only: absolute path of the installed `@openai/codex-sdk` package directory                                                                  |

- Prefer the environment variables: `opencode.json` is often committed, and a key written there is
  shared with it. Surrounding whitespace in keys is trimmed. The plugin fails at startup when the
  provider has no key (or, for Cloudflare, no valid account ID or model name) or an invalid base
  URL. The variables are read by the process that loads the plugin: if OpenCode 2.x's background
  service was already running, run `opencode service restart` after exporting them.
- `typesafe`: the key and the base URL come from the same place. With
  `reviewer.decision.apiKey`, only `reviewer.decision.baseURL` applies
  (`TYPESAFE_BASE_URL` is ignored); with `TYPESAFE_API_KEY`, only `TYPESAFE_BASE_URL` applies, and
  setting `reviewer.decision.baseURL` without a key next to it fails at startup. This keeps
  one source from redirecting a key supplied by another.
- `cloudflare`: requests always go to
  `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run/@cf/cloudflare/<model>`; there
  is no base URL option, so the token never reaches another host. The variable names match
  wrangler's, but a `CLOUDFLARE_API_TOKEN` exported for deployments is often broad — create a token
  scoped to Workers AI for the reviewer. AI Gateway is not supported yet.
- A decision model returns a choice with calibrated probabilities rather than an explanation, so
  the verdict reason reads like `clef chose deny (allow 0.01, deny 0.86, escalate 0.13).` A
  hesitant `allow` below `minAllowProbability` is escalated to a human; `deny` and `escalate` are
  taken as answered.
- Measured from a devcontainer on 2026-10-04, a review took 0.2–0.9 s on either Clef model. Both
  Clef models allowed `pnpm test` and denied sending `.env` to a remote host, but `clef-flash` followed
  [custom review instructions](#custom-review-instructions) only weakly (a force-push declared safe
  rose to allow 0.53, under the default threshold, where `clef` reached 0.80), which is why `clef`
  is the default.
- The operation leaves your machine: the resource holds the full command, file content of a
  write or edit, and permission metadata such as diffs, and the user intent is your latest prompt.
  All of it is sent to the provider, so an edit of a secrets file sends those secrets.
- An operation is never sent in part, since a partial view cannot justify an approval. One whose
  estimated size exceeds `maxStateTokens` (or, with [long context](#long-context-typesafe),
  `longContext.maxStateTokens`), or that the API refuses as too long, is
  [too large](#operations-too-large-for-the-decision-model): by default it escalates to a human with
  the reason.
- `baseURL` must use HTTPS unless it points at a loopback host (`localhost`, `127.0.0.1`,
  `[::1]`). Whoever serves it receives the API key and decides every verdict, so set it only in
  configuration you trust (not a repository's `opencode.json` you have not reviewed) — the same
  holds for `minAllowProbability`, which lowers the bar for an automatic approval, and for
  `longContext`, which lets larger operations be approved automatically.
- Redirects are refused so the API key is never forwarded to another host, and the timeout covers
  the whole request including the response body. HTTP errors (`402` out of credit, `429` rate
  limited, `5xx` outage) are reported by status only and handled like any other reviewer failure.
- `reviewer.agent` has no effect with the `decision` backend unless `onOversize` is `"agent"`, and
  `reviewer.decision` none with the `agent` backend. Aliases such as `jev-latest` follow new model releases, which may shift
  verdicts; pin a version for stable behavior.

### Operations too large for the decision model

Jev refuses a question over 32Ki tokens (the `state` plus the question; Jev 1.14's 64Ki is per
request, shared by its questions, and the plugin asks one) unless
[long context](#long-context-typesafe) is on, and Clef, which accepts 64Ki, slows to tens of seconds
past 20,000. Before sending, the plugin estimates the size conservatively (ASCII at 2.5 characters
a token, any other character at 1.1 tokens: Japanese measured about one token per character on
both models, so a Japanese file reaches Jev's default 28,000-token budget at about 25,000
characters; Clef's default is 20,000 to stay within the default timeout)
and treats Jev's `max_tokens_exceeded` the same way. What happens next is
`reviewer.decision.onOversize`:

| `onOversize`         | Too-large operation                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `escalate` (default) | Not approved: `on-ask` leaves OpenCode's prompt for a human; `all-tools` blocks the tool with the reason |
| `agent`              | Reviewed by the [agent](#configuration) reviewer, which can also read the file it concerns               |
| `chat`               | Reviewed by the [chat backend](#chat-backend) in one call, with the whole operation                      |

A fallback reviews the whole operation, so its `allow` stands. Choose a fallback model at least as
careful as the decision model: an operation padded past the budget reaches it instead, and it has
no `minAllowProbability` gate. Use it where nobody can answer a
prompt — OpenCode working inside a GitHub Actions workflow, for example — so that a large edit
does not stop the run. The default stays `escalate`: a fallback can widen what is approved
automatically, so set it only in configuration you trust, like `baseURL` and
`minAllowProbability`. Each reviewer has its own `reviewer.timeoutMs`, so a fallback review can take
up to twice as long.

```jsonc
"reviewer": {
  "backend": "decision",
  "decision": { "provider": "typesafe", "onOversize": "chat" },
  "chat": { "baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}", "model": "openai/gpt-5.6-luna" },
}
```

### Long context (TypeSafe)

TypeSafe's `TypeSafe-Danger-Zone-Long-Context: true` header raises Jev's limit to 262,144 tokens
per question and per request (Jev 1.13 and 1.14), at the same price per token. With
`reviewer.decision.longContext` set, an operation whose estimate exceeds `maxStateTokens` is sent
whole with that header instead of being too large, up to `longContext.maxStateTokens`; smaller
operations are still sent without it. If Jev refuses one of those as too long (the estimate fell
short), it is asked once more with the header, within the same `timeoutMs`; with less than a
second left, or if that second request fails, the refusal stands.

```jsonc
"decision": {
  "provider": "typesafe",
  "longContext": { "maxStateTokens": 120000, "minAllowProbability": 0.9 },
}
```

| Option                                              | Default                                   | Description                                                                      |
| --------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `reviewer.decision.longContext`                     | off                                       | `true` turns it on with the defaults below; an object sets them                  |
| `reviewer.decision.longContext.maxStateTokens`      | `240000`                                  | Estimated size above which even a long-context request is too large (≤256,000)   |
| `reviewer.decision.longContext.minAllowProbability` | `0.8`, or `minAllowProbability` if higher | Allow threshold for long-context answers only; never below `minAllowProbability` |

- It is off by default: TypeSafe documents long-context answers as slower and less accurate than
  those within the regular limit, so only the operations that need it use it. An operation past
  `longContext.maxStateTokens`, or that the API refuses even with the header, is too large and
  follows `onOversize`.
- A verdict reached this way, including after such a retry, says so, e.g.
  `jev-1.14.0 with long context chose escalate (allow 0.32, deny 0.07, escalate 0.61).` A single
  dangerous line is easier to miss in a large file, so these answers need a higher `allow`
  probability (0.8 by default) and the threshold cannot be set below the regular one.
- Measured on 2026-10-16: 54k tokens answered in 0.8 s, 134k in about 2 s and 241k in 4.4 s, all
  within the default `timeoutMs`; 272k was refused. A long, harmless write of this plugin's own
  sources (69k tokens) leaned `escalate` (0.57–0.61) where a single file of it leaned `allow`;
  a 34k-token edit of them came back `allow 0.76`, which the default 0.8 escalates.
- Long context costs what its tokens cost: a 240,000-token review is about $0.01 at Jev's
  $0.042 per million input tokens, recorded in the usage log like any other review.
- Clef on Workers AI has no such switch; `longContext` other than `false` with
  `provider: "cloudflare"` fails at startup.

### Chat backend

Set `reviewer.backend` to `"chat"` to have an LLM review each operation in a single request — to an
OpenAI-compatible `POST <baseURL>/chat/completions`, or to the OpenAI or Anthropic API with their
own keys — or use it only as the decision backend's `onOversize` fallback. It sends the agent reviewer's prompt — the user's instructions, then the
operation inside a random boundary it is told never to take instructions from — and reads back a
`{"verdict","reason"}` JSON object. There is no session and no tool, so it judges the operation data
alone, and the plugin needs an API key of its own.

| Option                        | Default                                                                              | Description                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `reviewer.chat.provider`      | `"openai-compatible"`                                                                | `"openai-compatible"`, `"openai"` or `"anthropic"` (below)                                   |
| `reviewer.chat.model`         | — (required)                                                                         | Model ID as the endpoint names it, such as `openai/gpt-5.6-luna` on OpenRouter               |
| `reviewer.chat.apiKey`        | per provider (below)                                                                 | API key for the endpoint                                                                     |
| `reviewer.chat.baseURL`       | `openai-compatible`: `AUTO_APPROVAL_CHAT_BASE_URL`, else `https://api.openai.com/v1` | `openai-compatible` only: base URL up to `/chat/completions`; HTTPS (HTTP only for loopback) |
| `reviewer.chat.maxInputBytes` | `200000`                                                                             | A prompt longer than this (UTF-8 bytes) is too large and escalates unsent                    |

| `reviewer.chat.provider`        | Endpoint                                               | Key, when `reviewer.chat.apiKey` is unset |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `"openai-compatible"` (default) | `<baseURL>/chat/completions`                           | `AUTO_APPROVAL_CHAT_API_KEY`              |
| `"openai"`                      | `https://api.openai.com/v1/chat/completions`           | `OPENAI_API_KEY`                          |
| `"anthropic"`                   | `https://api.anthropic.com/v1/messages` (Messages API) | `ANTHROPIC_API_KEY`                       |

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "reviewer": {
          "backend": "chat",
          "chat": { "provider": "anthropic", "model": "claude-haiku-5-5" },
        },
      },
    },
  ],
}
```

- `openai` and `anthropic` always call the vendor's own host, so they take no `baseURL` (setting
  one fails at startup) and their key never reaches another server. They read the vendor's usual
  key variable, which other tools may already export — so a repository's `opencode.json` that
  selects one of them spends that key, one more reason to set `reviewer.chat` only in configuration
  you trust. A Claude Code or Codex sign-in is not an
  API key and cannot be used here; [agent runtimes](#agent-runtimes) use those. `anthropic`
  sends the key in `x-api-key` with `anthropic-version: 2023-06-01` and `max_tokens: 16000`, so
  the verdict fits after whatever thinking the model does by default; pick a model whose output
  limit allows that (current Claude models do). A reply that stops for any reason other than
  finishing — a refusal, `max_tokens` — is handled like any other reviewer failure, and one that
  ran out of context window counts as too large.
- For `openai-compatible`, as with TypeSafe, the key and the base URL come from the same place: `reviewer.chat.apiKey`
  with `reviewer.chat.baseURL`, or `AUTO_APPROVAL_CHAT_API_KEY` with `AUTO_APPROVAL_CHAT_BASE_URL`,
  never one from each. OpenCode substitutes `{env:NAME}` in plugin options, so an existing variable
  such as `OPENROUTER_API_KEY` can be used without writing the key down.
- The same safeguards apply as for the decision backend: redirects are refused, the timeout covers
  the whole response, errors report the HTTP status only, and an over-long prompt
  (`context_length_exceeded`, Anthropic's "prompt is too long", a context length, size or window
  message, or HTTP 413) counts as too
  large.
- Keep `maxInputBytes` within what the server reads whole: for a local server, no more bytes than
  its context has tokens (Ollama's `num_ctx`) less room for the answer and the chat template, a few
  hundred tokens — a byte-level tokenizer never makes more than one
  token a byte, whatever characters the operation is padded with. Some servers cut an over-long
  prompt instead of refusing it, from the start or the middle. Three guards catch that, each
  treating the operation as too large:
  - every prompt (agent reviewer too) opens with a random review check that the answer must echo,
    so a model whose prompt lost its start cannot answer;
  - a reported prompt-token count below a floor under the measured densities (10 ASCII characters,
    2 CJK characters or 6 other characters a token) means part of the prompt was not read — zero or no count says
    nothing, and cached tokens count as read;
  - the task, the untrusted-data rule and the answer format are restated after the operation data.

  With every backend, a reply that holds two verdicts carrying the check is refused. In a reply with
  more than 40 opening or closing braces, which the parser does not search whole, the word
  `verdict` (in any case) or the check appearing more than once, or any `\u` escape, is refused
  the same way, so a brace-heavy answer that discusses verdicts in its reasoning goes to a human.

  A cut that keeps the start can still go unnoticed if it is under about two fifths of English
  prose, two thirds of code or JSON, or half of Japanese; size `maxInputBytes` to the server's
  context instead of relying on the guards.

- Set `reviewer.chat` — like `onOversize`, `baseURL` and `minAllowProbability` — only in
  configuration you trust. The same-source rule stops one source redirecting a key from another, but
  OpenCode substitutes `{env:NAME}` before the plugin sees the options, so a repository's
  `opencode.json` could pair your own key variable with its own server.
- The usage log records chat reviews with `provider: "chat"` and the token counts the endpoint
  reports; their cost is left unpriced, since it depends on the provider and model.

### What reviewers receive

Every backend reviews the same state: the request's `source` (`permission-request` or `tool-call`),
the permission `action` or tool name, the `resource` (the permission request's patterns or
resources and metadata, or the whole tool input — commands, file paths, file contents, patches),
the latest user prompt as `userIntent`, and the [bounded conversation](#bounded-conversation-context-opt-in)
when you enable it. The agent backend also sees whatever its read-only tools read from the
workspace. That state goes to the reviewer's provider, so treat it as sent there.

- **Credentials are redacted by default.** Before a review starts, every string in that state is
  copied with credential values replaced by markers such as `[REDACTED]`: the `reviewer.decision` /
  `reviewer.chat` API keys, complete private key blocks, URL passwords, well-known token formats
  (GitHub, OpenAI, GitLab, TypeSafe), and a secret-shaped value after `Authorization:` /
  `X-API-Key:` / `Bearer`, a `--password` / `--token`-style flag, or in a `*_KEY=` / `*_TOKEN=` /
  `*_SECRET=` / `*_PASSWORD=`-style assignment. The tool OpenCode runs is never changed, and the
  reviewer is told what the markers mean. Redaction is deliberately conservative so that crafted
  text cannot hide a destination, a file or a command from the reviewer: a secret-shaped value is
  one run of 16 or more letters, digits and `_+=-` (or a JWT), so nothing with a space, a quote,
  shell syntax, `.`, `/`, `~`, `:` or `@` — no path, host or URL — is ever replaced, and
  `SSH_AUTH_SOCK=` / `*_PATH=` values stay visible. A short password, a secret in another shape, an
  SDK runtime's own key in the environment, or one the reviewer reads from a file still reaches
  the provider, and so does a value in a variable the same text names again (`$NAME`,
  `printenv NAME`), since it may decide what runs; token formats inside a path or file name stay
  visible too. Strings over 262,144 characters are only checked for the API keys, private keys and
  token formats. Add up to 50 regular expressions of up to 500 characters with
  `reviewer.redact.patterns` (a match is replaced only when it is itself secret-shaped — 16 or more
  of `[A-Za-z0-9_+=-]`, or a JWT — and a pattern that matches the empty string is rejected), or turn redaction off with `reviewer.redact.enabled: false` when the reviewer must see
  the values. Like `instructions`, set `reviewer.redact` only in configuration you trust: a broad pattern
  can hide what a reviewer should see.
- **Size is bounded and fails closed.** An operation larger than `reviewer.agent.maxInputBytes`,
  `reviewer.chat.maxInputBytes` or `reviewer.decision.maxStateTokens` is never sent in part; it
  escalates to a human, or goes to the [fallback](#operations-too-large-for-the-decision-model)
  you configured.
- **Reviews in flight are capped.** At most `reviewer.maxConcurrentReviews` (default 4, 1–32)
  reviews run at once; more wait for a free slot for up to `reviewer.timeoutMs` and then escalate.
  The review itself is then bounded by `reviewer.timeoutMs` again, so a queued operation can take up
  to twice that before it is decided. There is no spending cap: watch the cost
  with [`stats`](#usage-and-cost-statistics) and your provider's own limits.

```jsonc
{
  "reviewer": {
    "maxConcurrentReviews": 2,
    "redact": { "patterns": ["acct-[0-9]{12}"] },
  },
}
```

### Usage and cost statistics

Each decision, chat, Claude Agent SDK or Codex SDK review appends one line to a usage log at
`$XDG_DATA_HOME/opencode-auto-approval-plugin/usage.jsonl` (`~/.local/share/…` when `XDG_DATA_HOME`
is unset): the time, provider, model, a hash of the project directory, input and output tokens,
latency, the verdict (`error` for a failed call, `oversize` for an operation too large to send),
and the cost at the time of the review. An operation handed to a fallback gets two lines: the
unsent `oversize` attempt and the fallback's review; the latency column leaves `oversize` out. The
operation, your prompt and the reason are never written, and the file is created readable by you
only. The project hash keeps the path out of the file but is not a secret — anyone who guesses a
path can hash it and match it — so treat the log as private before sharing it. Reviews with the
`agent` backend on the default `opencode` runtime run in OpenCode sessions, so `opencode stats`
already counts them.

Show the totals with the bundled command, modelled on `opencode stats`:

```sh
npx opencode-auto-approval-plugin stats              # this calendar year so far
npx opencode-auto-approval-plugin stats --days 7     # today and the 7 days before (0 = today)
npx opencode-auto-approval-plugin stats --year 2026
npx opencode-auto-approval-plugin stats --all --project . --json
```

```text
auto-approval stats · today and the 7 days before · all projects

reviews 1,284   tokens 612k in / 51k out   cost $0.11

provider    model       reviews  tokens in  tokens out      cost  p50 latency
cloudflare  clef            904       431k           0     $0.10       412 ms
typesafe    jev-latest      380       181k         51k  $0.00760       212 ms

verdicts  allow 81% · escalate 15% · deny 3% · error 1% · oversize 0%
```

- Costs use the input prices published on 2026-10-04 (USD per million tokens: Jev $0.042, Clef
  $0.24, Clef-flash $0.09; output tokens are free) and apply to the official endpoints only. A
  model without a known price, or a review sent to a custom `baseURL`, is counted but left out of
  the cost, and the summary says how many reviews that was. The latency column is the median.
- Set `reviewer.recordUsage` to `false` to stop writing the log. A failure to write it never
  affects a review.

### Custom review instructions

Set `reviewer.instructions` to tell the reviewer about your own policy, such as tool uses that are
always safe in your project or operations that must always go to a human. Give one string or a list
of strings; a list is joined into one line per entry, which is easier to read in JSON than one long
string.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "reviewer": {
          "instructions": [
            "`pnpm test`, `pnpm lint` and `pnpm typecheck` are always safe in this project.",
            "Reading and editing files under `src/` and `docs/` is safe.",
            "Always escalate `git push` and anything that touches `.env` files.",
          ],
        },
      },
    },
  ],
}
```

- Both backends receive the instructions as trusted guidance that takes precedence over the
  built-in safety guidance (or replaces it, with
  [`replaceDefaultPolicy`](#replacing-the-built-in-policy)) — though never over the answer format or the rule that operation data
  is untrusted, so text inside a command or file cannot pose as your instructions: the `agent`
  backend reads them in its prompt ahead of the operation data, and the `decision` backend
  appends them to the question's `instructions`, never to the state it judges.
- They are guidance for an AI reviewer, not deterministic rules: the reviewer still sees the whole
  operation and may decide otherwise. Use OpenCode's own permission rules (`permissions` on 2.x,
  `permission` on 1.x) when a tool must always be allowed or denied. Explicit OpenCode `deny` rules still always win.
- Blank entries are ignored, and the joined text may be at most 4,000 characters by default. Set
  `reviewer.maxInstructionsChars` (4,000–200,000) to allow a longer policy. The instructions are
  sent, and billed, with every review, and they count toward each reviewer's size limit: the
  `agent` and `chat` reviewers' `maxInputBytes` (UTF-8 bytes), and the decision model's
  `maxStateTokens` (or `longContext.maxStateTokens`). Very long instructions leave less room for
  the operation, so more reviews end up too large; instructions that would fill a limit in use
  make the plugin fail at startup. Near the top of the range, raise `maxInputBytes` as well (the
  default is 200,000 bytes, and a Japanese character takes three). With `longContext`, instructions
  larger than `maxStateTokens` send every review with long context and its stricter allow
  threshold.
- Instructions can widen what is approved automatically, so set them only in configuration you
  trust, like `baseURL`, `minAllowProbability` and `longContext` — not in a repository's `opencode.json` you have
  not reviewed.

#### Replacing the built-in policy

The built-in policy leans toward asking a human: it escalates whenever the user's intent is
unknown or the operation is ambiguous, and your instructions can only argue against it. Set
`reviewer.replaceDefaultPolicy` to `true` to make your instructions the whole policy instead.

```jsonc
{
  "reviewer": {
    "replaceDefaultPolicy": true,
    "instructions": [
      "Allow builds, tests, linters and type checks run through `pnpm` scripts, and `git add`, `git commit` and `git status`.",
      "Allow reading and editing files inside the workspace.",
      "Deny anything that sends files or environment variables over the network.",
      "Escalate everything else, including package installs, `git push` and compound commands.",
    ],
  },
}
```

- This drops the built-in rules about when to allow, deny or escalate — "decide whether it is safe
  and within the user's intent" and "if userIntent is null, escalate unless the operation is
  clearly harmless" — from the prompt of every backend, and the `decision` backend's verdict
  criteria become "your policy allows / forbids / wants a human or does not decide". An operation
  your policy does not decide is escalated.
- What stays: the answer format, the review check, the rule that operation data is untrusted and
  its boundary, the reviewer's role ("a security reviewer"), the conversation rules (only user
  turns authorize, and missing context needed for authorization is escalated), and the decision
  model's `minAllowProbability`.
- It needs `reviewer.instructions`; the plugin fails at startup without them.
- The reviewer no longer checks that an operation matches what you asked the agent to do. An agent
  steered by injected text (a README, an issue, a web page) gets anything your policy allows
  approved automatically, so write the policy in terms of what is safe to run unattended, and list
  what must still go to a human.
- Like `instructions`, set it only in configuration you trust — not in a repository's
  `opencode.json` you have not reviewed.

### Escalate rules (deterministic)

`reviewer.instructions` are guidance a model may still get wrong, and an injected or misled reviewer
can answer `allow` to anything. `escalate` lists operations that always go to a human: a matching
operation is escalated **before any reviewer sees it**, with every backend and both plugin API
generations. In `on-ask` mode the OpenCode prompt stays; in `all-tools` mode the tool is blocked
with the matched rule as the reason. Rules are off by default.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "escalate": [
          // Publishing, pushing and destroying (`shell` on OpenCode 2.x, `bash` on 1.x)
          { "action": "shell", "resource": "*git push*" },
          { "action": "shell", "resource": "*npm publish*" },
          { "action": "shell", "resource": "*rm -rf*" },
          // Network access
          { "action": "webfetch" },
          { "action": "shell", "resource": "*curl *" },
          // Credentials, by path
          { "action": "*", "resource": "*.env" },
          { "action": "*", "resource": "*.env.*" },
          { "action": "*", "resource": "*id_rsa*" },
        ],
      },
    },
  ],
}
```

- `action` is matched against the OpenCode permission action in `on-ask` mode and the tool name in
  `all-tools` mode. The shell is `shell` on OpenCode 2.x and `bash` on 1.x; list both when one
  configuration serves both. One permission action can cover several tools (`edit` covers `write`,
  `apply_patch` and friends), so write path rules with `"action": "*"` when they must hold in both
  modes.
- `resource` is matched against string **values** — a permission request's resources, patterns
  and metadata (except the diffs, patches and previews in it) and every string in a tool input, nested
  values included —
  each as a whole, line by line and word by word. Quotes and shell operators separate words, so
  `*.env` catches `cat ".env"`, `cat .env | head` and `$(cat .env)`. Two exceptions, for built-in
  tools only: what `write`, `edit` and `multiedit` write (`content`, `oldString`, `newString`) is
  not matched, so a path rule does not fire on code that mentions `process.env`, and the
  `patchText` of `apply_patch` / `patch` is matched through the file paths its `*** Add File:` /
  `Update File:` / `Delete File:` / `Move to:` headers name. Every other tool, MCP tools included,
  has all its strings matched, contents too. Object keys, numbers and booleans are not matched. A
  rule without `resource` matches every operation of its action. An operation more than 16 levels
  deep, with more than 10,000 strings or more than a million characters to match (counting each
  distinct whole string, line and word) escalates under any rule for its action.
- Patterns use OpenCode's wildcards: `*` matches anything (including nothing), `?` one character,
  and the whole string must match, so `git push *` matches `git push` and `git push origin` but not
  `cd repo && git push` as a whole `all-tools` command; write `*git push*` to catch it anywhere.
  (In `on-ask` mode OpenCode already splits a command line into its commands, so a pattern never
  spans `&&`.) A trailing ` *` also matches the
  bare command. Matching ignores case, shell line continuations and runs of whitespace, in patterns
  and values alike. It never goes through a regular expression, so it cannot backtrack: the cost
  grows with the value's and the pattern's length. Paths may arrive relative to the project in
  `on-ask` mode (`.env`) and absolute in `all-tools` mode, so start path patterns with `*`.
- The first matching rule, in configuration order, is the one reported. Escalations from a rule
  are written to the [audit log](#audit-log-opt-in) like any verdict. At most 200 rules; an
  `action` is at most 200 characters and a `resource` at most 1,000.
- Rules are a deterministic floor, not a sandbox. A shell command can spell the same thing many
  ways (`g""it push`, a variable, a script file, an alias) and a URL can be percent-encoded, which
  no pattern lists. In `on-ask` mode a rule only sees what OpenCode already asks about. The
  reviewer's own read-only session is not checked against the rules. Keep OpenCode `deny`
  permissions for what must never run; they stay authoritative whatever the reviewer says.
- With `allToolsNativeAsks: "review"`, a same-action native ask is answered from the reviewed call,
  which the rules already checked; its own resources are not matched again.

### Audit log (opt-in)

These options work with both plugin API generations and every reviewer backend. Add them to
the plugin's `options` object (the second tuple item under `plugin` on OpenCode 1.x):

```jsonc
{
  "auditLog": {
    "enabled": true,
    "path": "/absolute/private/directory/approval-audit.jsonl",
    "includeCommand": false,
  },
  "conversation": {
    "enabled": true,
    "includeAssistant": false,
  },
}
```

- `auditLog.enabled` and `auditLog.includeCommand` both default to `false`. Disabled auditing
  performs no log I/O. When enabled, `path` is required and must be an absolute filesystem path.
  There is no environment variable, home-directory fallback, or project-relative resolution.
  Choose a private directory outside version control; do not use a path controlled by an untrusted
  project. Parent directories are trusted: the no-follow check protects the final file, not every
  parent component. Only the target file is tightened to mode `0600`; existing directories are not modified.
- An existing regular file at `path` is appended to, whatever it is. Like `instructions` and
  `baseURL`, set `auditLog` only in configuration you trust — a repository's `opencode.json` could
  otherwise point it at a file such as a shell start-up script and have agent-controlled command
  text appended to it.
- JSONL records contain time, backend, session, source, action, verdict, confidence, duration in
  milliseconds and a fixed error category. Confidence is backend metadata (the decision model's
  selected-choice probability, including when an allow is escalated), or `null` when unavailable; it is never
  inferred from the reason. Reasons, raw errors, conversation and general tool input are not logged.
  A logged verdict is the reviewer's answer, not proof that the host executed or approved the operation.
- Command recording is a separate opt-in for actual `bash` commands or permission metadata,
  never permission patterns. Redaction is **best-effort, not exhaustive**: shell syntax, short flags
  such as `mysql -pSECRET`, `curl -u user:pass`, and here-documents can still expose credentials. Do not
  enable it for sensitive workloads. Inputs over 64 KiB (UTF-8) are omitted entirely before
  redaction; remaining redacted text is capped at 2,048 characters.
- Writes use append/create/write-only/no-follow flags, verify a regular single-link file and set
  its permissions to `0600` through the open handle before writing. A pre-placed symlink is refused.
  This requires POSIX no-follow and permission semantics: Windows auditing is unsupported and
  fails with a fixed warning rather than an unsafe fallback. Unsupported filesystems, bad paths
  and other log failures never change approval decisions.
- Logging is asynchronous and best-effort, with at most 1,000 queued entries plus one active
  write. A full queue drops new entries; errors and drops emit fixed, non-secret warnings.
  Shutdown can lose queued records. There is no automatic rotation or retention policy; manage
  the file yourself. This is not a durable compliance ledger.

### Bounded conversation context (opt-in)

`conversation.enabled` defaults to `false`: the reviewer then sees only the latest captured prompt.
Enabled, each review reads the current session's available history, retaining at most **8 whole turns / 12,000 characters**. Only user turns are included by
default, so a short request such as "continue" can refer to an earlier user instruction without
letting assistant prose establish consent. `conversation.includeAssistant: true` also sends
assistant text as untrusted context, never as authorization. Ordinary tool output, synthetic/ignored
parts, reviewer messages and compaction summaries are excluded.

On OpenCode V2 only, completed `question` tool results provide structured context from
`state.metadata.answers` even when `includeAssistant` is false. A question and its selectable
option labels are **authored by the agent**, not the user. Clicking an option records a choice,
not a new user-written command or unrestricted permission. The reviewer receives the
assistant-authored question next to the selected option labels and, separately, any custom
answers not matching an option. For incomplete question inputs with missing option definitions,
answer provenance remains explicitly unclassified. Each choice only applies to the action
actually asked about; a bare "Yes" does not authorize unrelated actions. The reviewer's
`userIntent` remains the latest ordinary user prompt, never an answer turn. Later revocations
take priority.

Questions and answers are JSON-encoded and capped; oversized or malformed completed results
are omitted and mark the conversation incomplete. Unfinished, cancelled and unrelated tool
calls do not establish consent. Multiple questions and multi-select choices stay paired.
This provides review context, **not automatic permission**, and requires
`conversation.enabled: true`. OpenCode V1 parsing is unchanged.

The V2 fields are supported by OpenCode's own
[question-answer rendering](https://github.com/anomalyco/opencode/blob/726cf096396d5014c3b1845e231cc01efe0421ee/packages/tui/src/routes/session/index.tsx),
[question answer schema](https://github.com/anomalyco/opencode/blob/726cf096396d5014c3b1845e231cc01efe0421ee/packages/schema/src/question.ts),
and [V2 assistant tool-part type](https://github.com/anomalyco/opencode/blob/726cf096396d5014c3b1845e231cc01efe0421ee/packages/client/src/promise/generated/types.ts).
No `AGENTS.md` files are automatically loaded into the payload; configured
`reviewer.instructions` still apply to every backend.

History reads can add up to **1 second** (`HISTORY_TIMEOUT_MS`) before each review, including every
tool call in `all-tools` mode. V1 requests at most **32 host messages** (`HISTORY_MESSAGE_LIMIT`);
V2 reads the host's context view, which may already have been compacted. There is no history cache.
Earlier user turns widen what the reviewer may treat as authorized — an old instruction can back an
operation the latest prompt does not mention — which is why the context is opt-in. The timeout
stops waiting, not necessarily the underlying host read. Failures fall back to the latest captured
prompt and mark the context incomplete.

`incomplete` records observed compaction, local clipping or a failed history read, not an assumption
that all history is missing. A full V1 page separately sets `historyLimitReached`: older messages
may exist but their omission is not known. Neither a false flag nor a short response guarantees
complete host history. The latest user request/revocation takes precedence; missing authorization
must be escalated. A new user prompt during history loading or review cancels an otherwise allowed
result. These are model instructions plus a host-side stale-result guard, not a guarantee against
prompt injection.

Subagent sessions (started by the `task` tool) are prompted by the parent agent, not by you, so
their prompts never count as user intent. A review of an operation in a subagent session follows
the session's `parentID` chain to the root session and uses that session's latest prompt and, when
enabled, its conversation; a new prompt there also cancels the subagent's pending result. A
resolved chain is cached; a failed or timed-out lookup is retried on the next review. The lookup
has its own 1-second timeout, so a review can wait up to 2 seconds with history enabled. If the
chain cannot be read in time, the operation is reviewed without any user intent (an enabled
conversation is marked incomplete), and only a new prompt in the subagent session itself cancels
its pending result.

Every backend receives the same operation data, and the retained conversation counts toward each
backend's size limit: an operation that no longer fits is handled like any other oversized one
(see `onOversize` above), never sent in part. The retained text goes to the selected reviewer
provider with every review (and is billed with the decision and chat backends); it may contain
sensitive user content. Audit redaction does not redact model input. Disabling assistant turns
reduces this exposure but does not eliminate it.

### Deprecated names

Earlier versions used other names for the backends and their options. They are still accepted and
mean the same thing, with no removal date yet; setting a name next to its replacement fails at
startup so that neither is silently ignored.

| Deprecated                                       | Use instead                                       |
| ------------------------------------------------ | ------------------------------------------------- |
| `backend: "opencode"`                            | `backend: "agent"`                                |
| `reviewer.model`                                 | `reviewer.agent.model`                            |
| `backend: "decision-model"` (v0.5)               | `backend: "decision"`                             |
| `reviewer.decisionModel` (v0.5)                  | `reviewer.decision`                               |
| `backend: "jev"` with `reviewer.jev` (v0.3–v0.4) | `backend: "decision"` with `provider: "typesafe"` |

### Native permission checks in all-tools mode (V2 opt-in)

By default, `all-tools` reviews every tool call **and preserves all native
OpenCode permission requests**, including mandatory human checkpoints.
AI approval does not silently replace a configured native `ask`.

OpenCode **V2 only** can opt in to letting the reviewer handle those subsequent
native asks with `allToolsNativeAsks: "review"`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "all-tools",
        "allToolsNativeAsks": "review",
      },
    },
  ],
}
```

The default is `"preserve"`; it is deliberately **not** enabled during upgrades.
`"review"` is rejected at startup with `mode: "on-ask"` and on OpenCode 1.x, where
it would have no effect. Reviewers still cannot bypass an
explicit native `deny`, and an AI `deny` or `escalate` always blocks the
tool call. Native asks for the same reviewed tool call are scoped to its
session, agent, message and invocation, automatically expire after 45 seconds,
and are revoked when the user prompts the root session again.

With the option on, the reviewer also answers the explicit `ask` rules you
configured yourself (for example `"git push *": "ask"`) for reviewed calls; those
no longer reach you once the call's review allows it.

Only the native action matching the already reviewed tool is granted without
another review. Its resources are **not** compared with the reviewed input: a
custom or MCP tool that asks for its own action with resources it resolves at run
time gets those resources allowed on the strength of the input review. Extra
actions, particularly `external_directory` with its
resolved path, receive a separate review that can approve or deny the actual
resources. Failed or escalated extra reviews are denied without an interactive
prompt. This may cost an additional model call.

Other plugins and core hooks may mutate a tool's name or input after the
reviewer's `execute.before` hook. The plugin blocks a call that changed while it
was being reviewed, and before granting a native ask it checks that the call still
matches what was reviewed; a changed call leaves the ask to a human. These checks
rely on later hooks changing the same event object that OpenCode then runs. A
change made after the review and after the last native ask (or in a call that
raises no native ask) is only detected in `execute.after`, **after execution**: the plugin then throws,
but the plugin API does not define what OpenCode does with that error, and the
tool has already run. This is not
a hard security boundary. Use only with trusted plugins and hooks. Native asks
granted this way are not written to the [audit log](#audit-log-opt-in).

This option assumes OpenCode runs `tool.execute.before` before the tool's native
permission check, as OpenCode 2.x core does. On a host that checks first, the
grant does not exist yet and the native ask stays with a human.

### Review modes

| Mode                                                 | Reviewed operations                                           | `allow`                                              | `deny`                               | `escalate` / reviewer failure                             |
| ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `on-ask` (default)                                   | Only operations that OpenCode already decided should ask      | Approves the request once                            | Leaves the OpenCode approval pending | Leaves the OpenCode approval pending                      |
| `all-tools`                                          | Every intercepted tool call, including OpenCode-allowed calls | Runs the tool                                        | Blocks the tool                      | Blocks the tool and reports that human review is required |
| `all-tools` with `allToolsNativeAsks: "review"` (V2) | Every intercepted tool call, plus the native asks it raises   | Runs the tool and answers its same-action native ask | Blocks the tool                      | Blocks the tool; an extra native action is denied         |

On OpenCode 2.x, `on-ask` (and `all-tools` with `allToolsNativeAsks: "review"`, for the native asks
of reviewed calls only) runs inside the `permission.evaluate` hook: an `allow` verdict turns the
pending `ask` into `allow` before the permission prompt is shown, and the reviewer's reason is
attached as the permission message. On OpenCode 1.x the plugin listens for the permission bus
event and replies `once` through the SDK. In both cases anything other than `allow` leaves
OpenCode's native human permission UI untouched.

OpenCode's plugin API does not provide a way to create and await a new permission dialogue from
`tool.execute.before`. Therefore, `all-tools` fails closed for an `escalate` verdict: the tool does
not run and the user must explicitly retry after reviewing the reported reason.

Both modes work the same way with every reviewer backend. An operation too large for the decision
or chat backend escalates unless a fallback is configured (see above).

Explicit OpenCode `deny` rules always remain in effect. The plugin is an additional review layer;
it never turns a built-in deny into an allow.

## Toolchain

| Area              | Tool                                                                              | Config                                                      |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Runtime / tooling | [mise](https://mise.jdx.dev/)                                                     | `mise.toml`                                                 |
| Package manager   | [pnpm](https://pnpm.io/)                                                          | `pnpm-workspace.yaml`, `.npmrc`                             |
| Language          | [TypeScript](https://www.typescriptlang.org/)                                     | `tsconfig.json`                                             |
| Build             | [tsdown](https://tsdown.dev/)                                                     | `tsdown.config.ts`                                          |
| Test              | [Vitest](https://vitest.dev/)                                                     | `vitest.config.ts`                                          |
| Format            | [oxfmt](https://oxc.rs/)                                                          | `.oxfmtrc.json`                                             |
| Lint              | [oxlint](https://oxc.rs/)                                                         | `.oxlintrc.json`                                            |
| Unused code       | [knip](https://knip.dev/)                                                         | `knip.ts`                                                   |
| Spelling          | [cspell](https://cspell.org/)                                                     | `cspell.json`                                               |
| Secret scanning   | [secretlint](https://github.com/secretlint/secretlint)                            | `.secretlintrc.json`                                        |
| Git hooks         | [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) + lint-staged | `package.json`, `.lintstagedrc.js`                          |
| AI rules          | [rulesync](https://github.com/dyoshikawa/rulesync)                                | `rulesync.jsonc`, `.rulesync/`                              |
| Workflow lint     | [actionlint](https://github.com/rhysd/actionlint)                                 | `.github/workflows/actionlint.yml`                          |
| Action pinning    | [pinact](https://github.com/suzuki-shunsuke/pinact)                               | `.pinact.yaml`, `.github/workflows/pinact.yml`              |
| Dependency bumps  | Dependabot                                                                        | `.github/dependabot.yml`                                    |
| Misconfig scan    | [Trivy](https://trivy.dev/)                                                       | `.trivyignore`, `.github/workflows/trivy-security-scan.yml` |
| Dev environment   | [Dev Container](https://containers.dev/)                                          | `.devcontainer/`                                            |
| CI / Release      | GitHub Actions                                                                    | `.github/workflows/ci.yml`, `publish.yml`                   |

## Getting started

```bash
mise install       # install node, pnpm, actionlint, pinact
pnpm install       # install dependencies and set up the pre-commit hook
pnpm cicheck       # run everything CI runs
```

## Scripts

| Script                 | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `pnpm build`           | Build the library (ESM + CJS, types) and the `stats` bin into `dist` |
| `pnpm check`           | `fmt:check` + `oxlint` + `typecheck`                                 |
| `pnpm cicheck`         | `cicheck:code` + `cicheck:content` — what CI runs                    |
| `pnpm cicheck:code`    | `check` + `test`                                                     |
| `pnpm cicheck:content` | `cspell` + `secretlint`                                              |
| `pnpm fix`             | Auto-fix formatting and lint problems                                |
| `pnpm generate`        | Regenerate AI tool configs from `.rulesync/`                         |
| `pnpm knip`            | Report unused files, exports, and dependencies                       |
| `pnpm test`            | Run the test suite                                                   |
| `pnpm test:coverage`   | Run the test suite with coverage                                     |
| `pnpm typecheck`       | Type-check without emitting                                          |

## mise tasks

| Task                    | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `mise run actionlint`   | Lint GitHub Actions workflows                             |
| `mise run pinact`       | Pin actions in workflows to full commit SHAs              |
| `mise run pinact:check` | Fail if any action is not pinned to a commit SHA          |
| `mise run trivy`        | Scan `.devcontainer/` and workflows for misconfigurations |

## Supply chain hardening

- `.npmrc` sets `save-exact=true`, so every dependency is pinned to an exact version.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so a version published less than a day ago is
  refused — a compromised release has time to be pulled before it reaches a lockfile.
- Postinstall scripts are blocked by default via `allowBuilds`; add a package there only when a build
  step is genuinely required. CI installs with `--ignore-scripts`.
- Every third-party GitHub Action is pinned to a full-length commit SHA, enforced by `pinact` in CI.
- Workflows declare the narrowest `permissions:` block they need.
- `secretlint` runs over every staged file through lint-staged, and over the whole tree in CI.
- `trivy config` scans `.devcontainer/` and `.github/workflows/` for misconfigurations on every push
  and pull request that touches them; `CRITICAL` and `HIGH` findings fail the build. Suppressions
  live in `.trivyignore`, each with the reason it is safe.
- The dev container pins the Codex CLI installer to a version and verifies its SHA-256 checksum
  before running it.

## Dev container

`.devcontainer/` provides a sandboxed environment for running AI coding agents with relaxed
permissions. It is adapted from [dyoshikawa/rulesync](https://github.com/dyoshikawa/rulesync) and
ships Node, mise-managed tooling (including `actionlint` and `pinact`), `gh`, Claude Code, Codex
CLI, opencode, Gemini CLI, git-gtr, and zsh/bash with completions.

Open the repository in a Dev Container-aware editor and it builds from `.devcontainer/Dockerfile`,
then runs `.devcontainer/init.sh` to configure git credentials, the pnpm store, and `pnpm install`.

Secrets are read from the host environment, so export the ones you need before opening the
container — all of them are optional:

| Host variable                                                   | Forwarded as         |
| --------------------------------------------------------------- | -------------------- |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_GITHUB_TOKEN`       | `GITHUB_TOKEN`       |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_OPENAI_API_KEY`     | `OPENAI_API_KEY`     |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_GEMINI_API_KEY`     | `GEMINI_API_KEY`     |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_ZAI_API_KEY`        | `ZHIPU_API_KEY`      |
| `OPENCODE_AUTO_APPROVAL_PLUGIN_DEVCONTAINER_OPENCODE_API_KEY`   | `OPENCODE_API_KEY`   |

`mise.toml` is copied into the image at build time, so changing it requires rebuilding the
container.

## AI coding agent rules

Rules live in `.rulesync/` and are compiled into each tool's native format by `pnpm generate`:

- `.rulesync/rules/*.md` — instructions (overview, coding, testing, GitHub Actions security)
- `.rulesync/mcp.json` — MCP servers
- `.rulesync/hooks.json` — session hooks
- `.rulesync/permissions.jsonc` — per-tool permission settings
- `rulesync.jsonc` — which tools to generate for (Claude Code, Codex CLI, GitHub Copilot, opencode)

Generated files (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.github/instructions/`, …) are gitignored —
edit `.rulesync/**` instead, never the generated output.

## Publishing

`.github/workflows/publish.yml` publishes to npm when a GitHub Release is published, or when run
manually for a release tag. It checks that the tag is a semantic `v*.*.*` version, matches
`package.json`, and points to a commit in `main`; it then runs `pnpm cicheck`, builds, and publishes
through [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no npm token in
secrets).

Configure npm's trusted publisher for `dyoshikawa/opencode-auto-approval-plugin` to use GitHub
Actions and the `.github/workflows/publish.yml` workflow. For each later release, bump the package
version on `main`, create its matching `v<version>` tag, and publish the GitHub Release.

OpenCode publishes and distributes plugins as ordinary npm packages: users add the package name to
the `plugins` (2.x) or `plugin` (1.x) array in `opencode.json`, and OpenCode installs it at startup.
See the [OpenCode plugin documentation](https://opencode.ai/v2/docs/build/plugins/) and the
[V1 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/) for the loader and
cache behavior.

## License

[MIT](./LICENSE)
