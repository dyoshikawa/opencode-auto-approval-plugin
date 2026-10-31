import { type KnipConfig } from "knip";

const config: KnipConfig = {
  // `src/index.ts` is auto-detected from package.json `exports`/`main`/`module`.
  // Test files are listed explicitly because no enabled plugin covers them, and
  // the `stats` bin because knip does not read the `pack` entries in
  // vite.config.ts.
  entry: ["src/**/*.test.ts", "src/bin.ts"],
  project: ["src/**/*.ts"],
  ignoreDependencies: [
    // Referenced from .secretlintrc.json rather than imported from source.
    "@secretlint/secretlint-rule-preset-recommend",
    // Run by `vp fmt` / `vp lint`; pinned so `vp` does not pick up the copies
    // of a project this checkout is nested in (see pnpm-workspace.yaml).
    "oxfmt",
    "oxlint",
  ],
};

export default config;
