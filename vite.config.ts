import { defineConfig } from "vite-plus";

// One file configures the whole Vite+ toolchain: the library build
// (`vp pack`), the formatter (`fmt`), the linter (`lint`) and the pre-commit
// checks (`staged`). The unit tests have their own `vitest.config.ts`.
export default defineConfig({
  // `vp pack` (tsdown).
  pack: [
    {
      entry: ["src/index.ts"],
      format: ["cjs", "esm"],
      dts: true,
      clean: true,
      fixedExtension: false,
    },
    {
      // The `stats` command; ESM only, as it is never imported.
      entry: { bin: "src/bin.ts" },
      format: ["esm"],
      dts: false,
      fixedExtension: false,
    },
  ],

  // `vp fmt` (Oxfmt).
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    arrowParens: "always",
    experimentalSortImports: {},
    ignorePatterns: [
      "package.json",
      "node_modules/**",
      "dist/**",
      ".vscode/settings.json",
      ".claude/settings.json",
      "opencode.jsonc",
      ".github/copilot-instructions.md",
      ".github/instructions/**",
      "rulesync.local.jsonc",
    ],
    overrides: [
      {
        files: ["**/*.json", "**/*.jsonc"],
        options: { trailingComma: "none" },
      },
    ],
  },

  // `vp lint` (Oxlint). Type checking stays with `tsc` (`pnpm typecheck`):
  // Oxlint's type-aware mode would add rules this package does not use.
  lint: {
    plugins: ["typescript", "import", "unicorn"],
    // Vite+'s own rule, which reports `vite` / `vitest` imports that should
    // come from `vite-plus`.
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    categories: {
      correctness: "error",
      suspicious: "warn",
      style: "off",
      pedantic: "off",
    },
    rules: {
      complexity: ["error", { max: 20 }],
      eqeqeq: "error",
      "import/no-cycle": "error",
      "no-console": "error",
      "no-new": "off",
      "no-underscore-dangle": "off",
      "typescript/no-explicit-any": "warn",
      "unicorn/prefer-node-protocol": "error",
      "unicorn/no-array-reduce": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    env: {
      browser: false,
      node: true,
      es2024: true,
    },
    ignorePatterns: ["dist/**", "coverage/**", "*.d.ts", "node_modules/**"],
    overrides: [
      {
        files: ["**/*.test.ts"],
        rules: {
          "typescript/no-explicit-any": "off",
        },
      },
    ],
  },

  // `vp staged`, run by the pre-commit hook (`.vite-hooks/pre-commit`).
  staged: {
    "*": "npx secretlint",
    "package.json": "npx sort-package-json",
    // Regenerate AI tool configurations when rulesync source files change.
    ".rulesync/**/*": () => "pnpm generate",
  },
});
