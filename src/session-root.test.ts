import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIntentTracker,
  createRootSessionResolver,
  MAX_SESSION_DEPTH,
  parentIdentifier,
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

  it("shares one walk between parallel lookups and caches a walk that meets a known root", async () => {
    const parentOf = lookup({ root: undefined, child: "root", grandchild: "child" });
    const resolve = createRootSessionResolver(parentOf);
    await Promise.all([resolve("child"), resolve("child")]);
    expect(parentOf).toHaveBeenCalledTimes(2);
    await expect(resolve("grandchild")).resolves.toBe("root");
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

describe("parentIdentifier", () => {
  it("reads parentID from a bare or {data}-wrapped session", () => {
    expect(parentIdentifier({ id: "child", parentID: "root" })).toBe("root");
    expect(parentIdentifier({ data: { id: "child", parentID: "root" } })).toBe("root");
    expect(parentIdentifier({ id: "root" })).toBeUndefined();
    expect(parentIdentifier({ id: "root", parentID: null })).toBeUndefined();
  });

  it("refuses anything that is not a session, so the lookup fails closed", () => {
    expect(() => parentIdentifier({})).toThrow();
    expect(() => parentIdentifier({ error: { message: "not found" } })).toThrow();
    expect(() => parentIdentifier({ id: "child", parentID: 1 })).toThrow();
  });
});

function tracker(roots: Record<string, string | undefined>) {
  return createIntentTracker({
    rootSession: async (sessionID) => roots[sessionID],
    conversation: async (root) => ({ userIntent: `intent of ${root}` }),
    conversationEnabled: true,
  });
}

describe("createIntentTracker", () => {
  it("hands a child session's review the root session's context", async () => {
    const intent = await tracker({ child: "root" }).begin("child");
    await expect(intent.context()).resolves.toEqual({ userIntent: "intent of root" });
  });

  it("marks a review stale when the root session is prompted, but not for the child's own prompts", async () => {
    const intents = tracker({ child: "root" });
    const intent = await intents.begin("child");
    intents.prompted("child");
    expect(intent.changed()).toBe(false);
    intents.prompted("root");
    expect(intent.changed()).toBe(true);
  });

  it("counts a root prompt that arrives while the root is still being looked up", async () => {
    const root = Promise.withResolvers<string | undefined>();
    const intents = createIntentTracker({
      rootSession: () => root.promise,
      conversation: async () => ({}),
      conversationEnabled: false,
    });
    const pending = intents.begin("child");
    intents.prompted("root");
    root.resolve("root");
    expect((await pending).changed()).toBe(true);
  });

  it("carries no intent when the root is unknown", async () => {
    const intents = tracker({});
    const intent = await intents.begin("child");
    await expect(intent.context()).resolves.toEqual({
      conversation: { turns: [], incomplete: true },
    });
    intents.prompted("child");
    expect(intent.changed()).toBe(true);
    const disabled = createIntentTracker({
      rootSession: async () => undefined,
      conversation: async () => ({}),
      conversationEnabled: false,
    });
    await expect((await disabled.begin("child")).context()).resolves.toEqual({});
  });
});
