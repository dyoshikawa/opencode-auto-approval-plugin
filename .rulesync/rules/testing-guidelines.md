---
root: false
targets: ["*"]
description: "When you write tests, must follow these guidelines."
globs: ["**/*.test.ts"]
---

# Testing Guidelines

- Test code files should be placed next to the implementation. This is called the co-location
  pattern.
  - For example, if the implementation file is `src/a.ts`, the test file should be `src/a.test.ts`.
- To avoid polluting git-managed files, tests that touch the filesystem must work inside
  `./tmp/tests/projects/{RANDOM_STRING}` as the project directory or `./tmp/tests/home/{RANDOM_STRING}`
  as the pseudo-home directory.
  - Mock `process.cwd()` to return the test directory. You must not use `process.chdir()` because it
    changes the current working directory globally and affects other tests.
- In tests, don't change directories or files outside the project directory, even in global mode.
- Run the test suite with `pnpm test`. Use `pnpm exec vp test run --silent=false` when you need to see
  logs.
