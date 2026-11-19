import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { missingTarget, targetedPaths, toolTargets } from "./path-guard.js";
import { testProjectDirectory } from "./test-directory.js";

let project: string;

beforeEach(() => {
  project = testProjectDirectory();
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("targetedPaths", () => {
  it("reads a read ask's requested paths from its resources", () => {
    expect(
      targetedPaths({ action: "read", resources: ["src/a.ts", join(project, "b.ts")] }),
    ).toEqual(["src/a.ts", join(project, "b.ts")]);
  });

  it("falls back to the metadata external target when the resources are empty", () => {
    expect(
      targetedPaths({
        action: "external_directory",
        resources: [],
        metadata: { filepath: "/elsewhere/file.txt" },
      }),
    ).toEqual(["/elsewhere/file.txt"]);
    expect(
      targetedPaths({
        action: "external_directory",
        resources: [],
        metadata: { parentDir: "/elsewhere" },
      }),
    ).toEqual(["/elsewhere"]);
  });

  it("takes only the search anchor for grep and glob, never the query", () => {
    expect(
      targetedPaths({
        action: "grep",
        resources: ["TODO"],
        metadata: { path: "/workspace/src" },
      }),
    ).toEqual(["/workspace/src"]);
    expect(targetedPaths({ action: "glob", resources: ["**/*.ts"], metadata: {} })).toEqual([]);
  });

  it("targets no path for actions whose payload is not a single filesystem path", () => {
    for (const action of ["bash", "edit", "write", "webfetch", "task", "shell"]) {
      expect(targetedPaths({ action, resources: ["missing.txt"] })).toEqual([]);
    }
  });

  it("drops blank entries", () => {
    expect(targetedPaths({ action: "read", resources: ["", "   "] })).toEqual([]);
  });
});

describe("toolTargets", () => {
  it("reads the file a read call opens", () => {
    expect(toolTargets({ tool: "read", input: { filePath: "src/a.ts" } })).toEqual(["src/a.ts"]);
  });

  it("reads the search anchor of a grep or glob call, never its query", () => {
    expect(
      toolTargets({ tool: "grep", input: { pattern: "TODO", path: "/workspace/src" } }),
    ).toEqual(["/workspace/src"]);
    expect(toolTargets({ tool: "glob", input: { pattern: "**/*.ts" } })).toEqual([]);
  });

  it("targets nothing for a tool whose arguments name no single path", () => {
    for (const tool of ["shell", "edit", "write", "apply_patch", "task", "webfetch"]) {
      expect(
        toolTargets({ tool, input: { filePath: "gone.txt", command: "rm gone.txt" } }),
      ).toEqual([]);
    }
    expect(toolTargets({ tool: "read", input: "not an object" })).toEqual([]);
  });
});

describe("missingTarget", () => {
  it("names the resolved path when every candidate is missing", async () => {
    expect(
      await missingTarget({ directory: project, candidates: ["gone.txt", "also-gone.txt"] }),
    ).toBe(join(project, "gone.txt"));
  });

  it("keeps the review when any candidate exists", async () => {
    writeFileSync(join(project, "here.txt"), "x");
    expect(
      await missingTarget({ directory: project, candidates: ["gone.txt", "here.txt"] }),
    ).toBeUndefined();
  });

  it("resolves relative candidates against the instance directory", async () => {
    mkdirSync(join(project, "dir"));
    expect(await missingTarget({ directory: project, candidates: ["dir"] })).toBeUndefined();
    expect(await missingTarget({ directory: project, candidates: ["dir/file.txt"] })).toBe(
      join(project, "dir/file.txt"),
    );
  });

  it("keeps the review for a glob-shaped candidate", async () => {
    for (const candidate of ["src/*.ts", "file?.txt", "a[bc].txt", "src/{a,b}"]) {
      expect(await missingTarget({ directory: project, candidates: [candidate] })).toBeUndefined();
    }
  });

  it("keeps the review when a parent is a file, not a directory", async () => {
    writeFileSync(join(project, "plain"), "x");
    // ENOTDIR is a missing target: the read fails the same way.
    expect(await missingTarget({ directory: project, candidates: ["plain/inner"] })).toBe(
      join(project, "plain/inner"),
    );
  });

  it("keeps the review when the stat fails for any other reason", async () => {
    // A path NUL cannot be represented in a POSIX name: stat fails without
    // ENOENT, and the guard must not deny an ask it cannot check.
    expect(await missingTarget({ directory: project, candidates: ["\0bad"] })).toBeUndefined();
  });

  it("keeps the review when the ask targets nothing", async () => {
    expect(await missingTarget({ directory: project, candidates: [] })).toBeUndefined();
  });
});
