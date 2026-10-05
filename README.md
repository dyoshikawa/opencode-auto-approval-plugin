# opencode-auto-approval-plugin

An [OpenCode](https://opencode.ai/) plugin that sends tool operations to a read-only AI reviewer
before automatically approving them.

The reviewer is one of three backends:

| `reviewer.backend` | How it reviews                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent` (default)  | An LLM in its own OpenCode session. It may inspect the workspace with `read`, `glob`, `grep`, and `lsp`, but cannot edit files, run shell commands, access the network, use MCP tools, or start subagents. |
| `chat`             | An LLM asked once through an OpenAI-compatible Chat Completions API — OpenAI, OpenRouter, Workers AI, a local server — with the same prompt as the agent but no session and no tools.                      |
| `decision`         | A [decision model](#decision-backend) over HTTP — TypeSafe AI's Jev or Cloudflare's Clef — that picks `allow`, `deny` or `escalate` with calibrated probabilities in one call.                             |

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

### Decision backend

Set `reviewer.backend` to `"decision"` to have a decision model judge each operation instead of an
OpenCode session. The plugin sends one request with the operation (`source`, `action`,
`resource`, and the user's latest prompt) and a single `allow` / `deny` / `escalate` choice. No
reviewer agent or session is created (unless `onOversize` is `"agent"`) and the workspace is not
inspected. Two providers speak the
same System One API:

| Provider     | Models                                                                                                  | Credentials (option / environment)                                       | Default model |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| `typesafe`   | [TypeSafe AI](https://typesafe.ai/)'s Jev (`jev-latest`, `jev-1.13.0`, …)                               | `apiKey` / `TYPESAFE_API_KEY`, optional `baseURL` / `TYPESAFE_BASE_URL`  | `jev-latest`  |
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

| Option                                  | Default                   | Description                                                                                                        |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `reviewer.backend`                      | `"agent"`                 | `"agent"`, `"chat"` or `"decision"`                                                                                |
| `reviewer.decision.provider`            | — (required)              | `"typesafe"` or `"cloudflare"`                                                                                     |
| `reviewer.decision.apiKey`              | from the environment      | TypeSafe AI API key, or a Cloudflare API token with Workers AI access                                              |
| `reviewer.decision.baseURL`             | `https://api.typesafe.ai` | `typesafe` only: API origin; a bare HTTPS origin (HTTP only for loopback)                                          |
| `reviewer.decision.accountId`           | from the environment      | `cloudflare` only: the 32-character account ID                                                                     |
| `reviewer.decision.model`               | per provider (above)      | Model or alias; pin a version such as `jev-1.13.0` for stable behavior                                             |
| `reviewer.decision.minAllowProbability` | `0.6`                     | An `allow` answered with a lower probability becomes `escalate`                                                    |
| `reviewer.decision.maxStateTokens`      | `28000`                   | Estimated size above which an operation is too large to send (1,000–60,000)                                        |
| `reviewer.decision.onOversize`          | `"escalate"`              | Too large: `"escalate"` to a human, or hand it to the `"agent"` or `"chat"` reviewer                               |
| `reviewer.agent.maxInputBytes`          | `200000`                  | The agent reviewer escalates a prompt longer than this (UTF-8 bytes) unsent rather than let the session compact it |

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
  estimated size exceeds `maxStateTokens`, or that the API refuses as too long, is
  [too large](#operations-too-large-for-the-decision-model): by default it escalates to a human with
  the reason.
- `baseURL` must use HTTPS unless it points at a loopback host (`localhost`, `127.0.0.1`,
  `[::1]`). Whoever serves it receives the API key and decides every verdict, so set it only in
  configuration you trust (not a repository's `opencode.json` you have not reviewed) — the same
  holds for `minAllowProbability`, which lowers the bar for an automatic approval.
- Redirects are refused so the API key is never forwarded to another host, and the timeout covers
  the whole request including the response body. HTTP errors (`402` out of credit, `429` rate
  limited, `5xx` outage) are reported by status only and handled like any other reviewer failure.
- `reviewer.agent` has no effect with the `decision` backend unless `onOversize` is `"agent"`, and
  `reviewer.decision` none with the `agent` backend. Aliases such as `jev-latest` follow new model releases, which may shift
  verdicts; pin a version for stable behavior.

### Operations too large for the decision model

Jev refuses a `state` over 32Ki tokens, and Clef, which accepts 64Ki, slows to tens of seconds
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

### Chat backend

Set `reviewer.backend` to `"chat"` to have an LLM review each operation in a single request to an
OpenAI-compatible `POST <baseURL>/chat/completions`, or use it only as the decision backend's
`onOversize` fallback. It sends the agent reviewer's prompt — the user's instructions, then the
operation inside a random boundary it is told never to take instructions from — and reads back a
`{"verdict","reason"}` JSON object. There is no session and no tool, so it judges the operation data
alone, and the plugin needs an API key of its own.

| Option                        | Default                                                         | Description                                                                    |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `reviewer.chat.model`         | — (required)                                                    | Model ID as the endpoint names it, such as `openai/gpt-5.6-luna` on OpenRouter |
| `reviewer.chat.apiKey`        | `AUTO_APPROVAL_CHAT_API_KEY`                                    | Bearer token for the endpoint                                                  |
| `reviewer.chat.baseURL`       | `AUTO_APPROVAL_CHAT_BASE_URL`, else `https://api.openai.com/v1` | Base URL up to `/chat/completions`; HTTPS (HTTP only for loopback)             |
| `reviewer.chat.maxInputBytes` | `200000`                                                        | A prompt longer than this (UTF-8 bytes) is too large and escalates unsent      |

- As with TypeSafe, the key and the base URL come from the same place: `reviewer.chat.apiKey`
  with `reviewer.chat.baseURL`, or `AUTO_APPROVAL_CHAT_API_KEY` with `AUTO_APPROVAL_CHAT_BASE_URL`,
  never one from each. OpenCode substitutes `{env:NAME}` in plugin options, so an existing variable
  such as `OPENROUTER_API_KEY` can be used without writing the key down.
- The same safeguards apply as for the decision backend: redirects are refused, the timeout covers
  the whole response, errors report the HTTP status only, and an over-long prompt
  (`context_length_exceeded`, a context length, size or window message, or HTTP 413) counts as too
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

  A cut that keeps the start can still go unnoticed if it is under about two fifths of English
  prose, two thirds of code or JSON, or half of Japanese; size `maxInputBytes` to the server's
  context instead of relying on the guards.

- Set `reviewer.chat` — like `onOversize`, `baseURL` and `minAllowProbability` — only in
  configuration you trust. The same-source rule stops one source redirecting a key from another, but
  OpenCode substitutes `{env:NAME}` before the plugin sees the options, so a repository's
  `opencode.json` could pair your own key variable with its own server.
- The usage log records chat reviews with `provider: "chat"` and the token counts the endpoint
  reports; their cost is left unpriced, since it depends on the provider and model.

### Usage and cost statistics

Each decision or chat review appends one line to a usage log at
`$XDG_DATA_HOME/opencode-auto-approval-plugin/usage.jsonl` (`~/.local/share/…` when `XDG_DATA_HOME`
is unset): the time, provider, model, a hash of the project directory, input and output tokens,
latency, the verdict (`error` for a failed call, `oversize` for an operation too large to send),
and the cost at the time of the review. An operation handed to a fallback gets two lines: the
unsent `oversize` attempt and the fallback's review; the latency column leaves `oversize` out. The
operation, your prompt and the reason are never written, and the file is created readable by you
only. The project hash keeps the path out of the file but is not a secret — anyone who guesses a
path can hash it and match it — so treat the log as private before sharing it. Reviews with the
`agent` backend run in OpenCode sessions, so `opencode stats` already counts them.

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
  built-in safety guidance — though never over the answer format or the rule that operation data
  is untrusted, so text inside a command or file cannot pose as your instructions: the `agent`
  backend reads them in its prompt ahead of the operation data, and the `decision` backend
  appends them to the question's `instructions`, never to the state it judges.
- They are guidance for an AI reviewer, not deterministic rules: the reviewer still sees the whole
  operation and may decide otherwise. Use OpenCode's own permission rules (`permissions` on 2.x,
  `permission` on 1.x) when a tool must always be allowed or denied. Explicit OpenCode `deny` rules still always win.
- Blank entries are ignored, and the joined text may be at most 4,000 characters. With the
  `decision` backend the instructions are sent, and billed, with every review.
- Instructions can widen what is approved automatically, so set them only in configuration you
  trust, like `baseURL` and `minAllowProbability` — not in a repository's `opencode.json` you have
  not reviewed.

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

### Review modes

| Mode               | Reviewed operations                                           | `allow`                   | `deny`                               | `escalate` / reviewer failure                             |
| ------------------ | ------------------------------------------------------------- | ------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `on-ask` (default) | Only operations that OpenCode already decided should ask      | Approves the request once | Leaves the OpenCode approval pending | Leaves the OpenCode approval pending                      |
| `all-tools`        | Every intercepted tool call, including OpenCode-allowed calls | Runs the tool             | Blocks the tool                      | Blocks the tool and reports that human review is required |

On OpenCode 2.x, `on-ask` runs inside the `permission.evaluate` hook: an `allow` verdict turns the
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
