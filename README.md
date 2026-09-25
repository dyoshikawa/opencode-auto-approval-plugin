# opencode-auto-approval-plugin

An [OpenCode](https://opencode.ai/) plugin that sends tool operations to a read-only AI reviewer
before automatically approving them.

By default the reviewer runs in its own OpenCode session. It may inspect the workspace with `read`,
`glob`, `grep`, and `lsp`, but cannot edit files, run shell commands, access the network, use MCP
tools, or start subagents. Alternatively, decisions can be delegated to the
[Jev](#jev-reviewer-backend) decision model over HTTP.

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

The defaults are `mode: "on-ask"`, a 30-second review timeout, and the provider/model of the main
session.

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

Set `reviewer.model` to run reviews through a separately configured OpenCode provider and model.
With the default `opencode` backend the plugin never reads or manages API keys; authentication
remains entirely in OpenCode.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "all-tools",
        "reviewer": {
          "model": {
            "providerID": "openrouter",
            "modelID": "openai/gpt-5.6-luna",
          },
          "timeoutMs": 15000,
        },
      },
    },
  ],
}
```

### Jev reviewer backend

Set `reviewer.backend` to `"jev"` to have [TypeSafe AI](https://typesafe.ai/)'s Jev decision model
judge each operation instead of an OpenCode session. The plugin sends one request to the System One
API with the operation (`source`, `action`, `resource`, and the user's latest prompt) and a single
`allow` / `deny` / `escalate` choice. No reviewer agent or session is created, the workspace is not
inspected, and a review typically answers in well under a second.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-approval-plugin",
      "options": {
        "mode": "on-ask",
        "reviewer": {
          "backend": "jev",
          "timeoutMs": 10000,
          "jev": {
            "model": "jev-latest",
            "minAllowProbability": 0.6,
          },
        },
      },
    },
  ],
}
```

| Option                             | Environment fallback | Default                   | Description                                                     |
| ---------------------------------- | -------------------- | ------------------------- | --------------------------------------------------------------- |
| `reviewer.backend`                 | —                    | `"opencode"`              | `"opencode"` (reviewer session) or `"jev"`                      |
| `reviewer.jev.apiKey`              | `TYPESAFE_API_KEY`   | — (required for `jev`)    | TypeSafe AI API key                                             |
| `reviewer.jev.baseURL`             | `TYPESAFE_BASE_URL`  | `https://api.typesafe.ai` | API origin; must be a bare HTTP(S) origin without a path        |
| `reviewer.jev.model`               | —                    | `"jev-latest"`            | Jev model or alias; pin a version such as `jev-1.13.0`          |
| `reviewer.jev.minAllowProbability` | —                    | `0.6`                     | An `allow` answered with a lower probability becomes `escalate` |

- Plugin options take precedence over the environment. Prefer the `TYPESAFE_API_KEY` environment
  variable: `opencode.json` is often committed, and a key written there is shared with it.
- The plugin fails at startup when the `jev` backend has no API key or an invalid base URL.
- Jev returns a choice with calibrated probabilities rather than an explanation, so the verdict
  reason reads like `Jev chose deny (allow 0.00, deny 0.99, escalate 0.01).` A hesitant `allow`
  below `minAllowProbability` is escalated to a human; `deny` and `escalate` are taken as answered.
- A resource larger than 32,000 characters of JSON (for example a large file write) is sent as a
  truncated preview, and an `allow` for it is escalated, because Jev saw only part of it.
- Redirects are refused so the API key is never forwarded to another host, and the timeout covers
  the whole request including the response body. HTTP errors (`402` out of credit, `429` rate
  limited, `5xx` outage) are reported by status only and handled like any other reviewer failure.
- `reviewer.model` has no effect with the `jev` backend. `jev-latest` follows new model releases,
  which may shift verdicts; pin a version for stable behavior.

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

Both modes work the same way with either reviewer backend.

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

| Script                 | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `pnpm build`           | Build ESM + CJS bundles and type declarations into `dist` |
| `pnpm check`           | `fmt:check` + `oxlint` + `typecheck`                      |
| `pnpm cicheck`         | `cicheck:code` + `cicheck:content` — what CI runs         |
| `pnpm cicheck:code`    | `check` + `test`                                          |
| `pnpm cicheck:content` | `cspell` + `secretlint`                                   |
| `pnpm fix`             | Auto-fix formatting and lint problems                     |
| `pnpm generate`        | Regenerate AI tool configs from `.rulesync/`              |
| `pnpm knip`            | Report unused files, exports, and dependencies            |
| `pnpm test`            | Run the test suite                                        |
| `pnpm test:coverage`   | Run the test suite with coverage                          |
| `pnpm typecheck`       | Type-check without emitting                               |

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
