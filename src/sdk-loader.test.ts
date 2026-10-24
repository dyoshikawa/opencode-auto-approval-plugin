import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { atLeast, importSdk } from "./sdk-loader.js";
import { testProjectDirectory } from "./test-directory.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A fake SDK package under ./tmp/tests/projects, returned with its entry's URL. */
function fakePackage(version: string): { directory: string; entry: string } {
  const directory = testProjectDirectory();
  directories.push(directory);
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "fake-sdk", version, exports: { ".": { import: "./dist/index.js" } } }),
  );
  writeFileSync(join(directory, "dist", "index.js"), "export const loaded = true;\n");
  return { directory, entry: pathToFileURL(join(directory, "dist", "index.js")).href };
}

describe("atLeast", () => {
  it.each([
    ["0.163.0", true],
    ["0.163.1", true],
    ["1.0.0", true],
    ["0.162.9", false],
    ["0.163.0-alpha.1", false],
    ["0.163.1-alpha.1", true],
    [undefined, false],
    ["latest", false],
  ])("compares %s with 0.163.0", (version, expected) => {
    expect(atLeast(version, "0.163.0")).toBe(expected);
  });

  it("lets a prerelease meet a prerelease minimum of the same release", () => {
    expect(atLeast("0.163.0-beta.2", "0.163.0-alpha.1")).toBe(true);
  });
});

function load(input: { sdkPath?: string; resolveInstalled?: () => string }) {
  return importSdk({
    packageName: "fake-sdk",
    option: "reviewer.agent.fakeSdk.path",
    importInstalled: async () => ({ installed: true }),
    minimumVersion: "0.163.0",
    ...input,
  });
}

describe("importSdk", () => {
  it("checks the version of the installed copy, not only of a configured directory", async () => {
    const old = fakePackage("0.162.0");
    await expect(load({ resolveInstalled: () => old.entry })).rejects.toThrow(
      "fake-sdk 0.162.0 from the installed package is older than the required 0.163.0.",
    );
    const current = fakePackage("0.163.0");
    await expect(load({ resolveInstalled: () => current.entry })).resolves.toEqual({
      installed: true,
    });
  });

  it("refuses an installed copy whose version cannot be found", async () => {
    await expect(load({})).rejects.toThrow("fake-sdk (no version) from the installed package");
    await expect(
      load({
        resolveInstalled: () => {
          throw new TypeError("import.meta.resolve is not a function");
        },
      }),
    ).rejects.toThrow("Could not load fake-sdk.");
  });

  it("refuses a prerelease of the minimum from a configured directory", async () => {
    const prerelease = fakePackage("0.163.0-alpha.1");
    await expect(load({ sdkPath: prerelease.directory })).rejects.toThrow(
      "fake-sdk 0.163.0-alpha.1 from reviewer.agent.fakeSdk.path is older than the required 0.163.0.",
    );
    const release = fakePackage("0.163.0");
    await expect(load({ sdkPath: release.directory })).resolves.toMatchObject({ loaded: true });
  });
});
