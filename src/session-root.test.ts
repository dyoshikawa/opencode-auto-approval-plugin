import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRootSessionResolver,
  MAX_SESSION_DEPTH,
  unknownRootContext,
} from "./session-root.js";

function lookup(parents: Record<string, string | undefined>) {
  return vi.fn(async (sessionID: string) => {
    if (!(sessionID in parents)) throw new Error(`unknown session ${sessionID}`);
    return parents[sessionID];
  });
}

describe("createRootSessionResolver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a root session with itself", async () => {
    const resolve = createRootSessionResolver(lookup({ root: undefined }));
    await expect(resolve("root")).resolves.toBe("root");
  });

  it("walks a nested subagent chain up to the root and caches it", async () => {
    const parentOf = lookup({ root: undefined, child: "root", grandchild: "child" });
    const resolve = createRootSessionResolver(parentOf);
    await expect(resolve("grandchild")).resolves.toBe("root");
    expect(parentOf).toHaveBeenCalledTimes(3);
    await expect(resolve("child")).resolves.toBe("root");
    await expect(resolve("grandchild")).resolves.toBe("root");
    expect(parentOf).toHaveBeenCalledTimes(3);
  });

  it("treats an empty parentID as a root", async () => {
    const resolve = createRootSessionResolver(lookup({ root: "" }));
    await expect(resolve("root")).resolves.toBe("root");
  });

  it("fails closed when a lookup fails", async () => {
    const resolve = createRootSessionResolver(lookup({ child: "missing" }));
    await expect(resolve("child")).resolves.toBeUndefined();
  });

  it("fails closed on a cycle", async () => {
    const resolve = createRootSessionResolver(lookup({ a: "b", b: "a" }));
    await expect(resolve("a")).resolves.toBeUndefined();
  });

  it("fails closed on a chain deeper than the limit", async () => {
    const parents: Record<string, string | undefined> = {};
    for (let depth = 0; depth <= MAX_SESSION_DEPTH + 1; depth++) {
      parents[`s${depth}`] = `s${depth + 1}`;
    }
    parents[`s${MAX_SESSION_DEPTH + 2}`] = undefined;
    const resolve = createRootSessionResolver(lookup(parents));
    await expect(resolve("s0")).resolves.toBeUndefined();
    await expect(resolve(`s${MAX_SESSION_DEPTH}`)).resolves.toBe(`s${MAX_SESSION_DEPTH + 2}`);
  });

  it("fails closed when the lookup does not answer in time", async () => {
    vi.useFakeTimers();
    const resolve = createRootSessionResolver(() => new Promise<string | undefined>(() => {}));
    const pending = resolve("child");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("unknownRootContext", () => {
  it("carries no intent and marks an enabled conversation incomplete", () => {
    expect(unknownRootContext(false)).toEqual({});
    expect(unknownRootContext(true)).toEqual({ conversation: { turns: [], incomplete: true } });
  });
});
