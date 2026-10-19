import * as z from "zod/mini";

import { HISTORY_TIMEOUT_MS, withTimeout } from "./conversation.js";

/** Subagents nest a few levels at most; a longer chain is treated as unknown. */
export const MAX_SESSION_DEPTH = 8;

/**
 * Resolve the root session of a (possibly child) session.
 *
 * A child session — a task-tool subagent — receives its prompts from the
 * parent agent, not from the person. Its "user" turns must therefore never
 * count as user intent; the person's intent lives in the root session.
 *
 * `parentOf` returns the session's `parentID`, or `undefined` for a root.
 * The resolver answers `undefined` when the chain cannot be read (lookup error,
 * timeout, cycle or a chain deeper than {@link MAX_SESSION_DEPTH}), so callers
 * fail closed and review the operation without any user intent.
 */
export function createRootSessionResolver(
  parentOf: (sessionID: string) => Promise<string | undefined>,
): (sessionID: string) => Promise<string | undefined> {
  // A session's parent never changes, so a resolved root can be reused.
  const roots = new Map<string, string>();
  // Parallel tool calls of one session share a single walk up the chain.
  const pending = new Map<string, Promise<string | undefined>>();
  const walk = async (sessionID: string): Promise<string | undefined> => {
    const seen = new Set<string>();
    let current = sessionID;
    for (let depth = 0; depth <= MAX_SESSION_DEPTH; depth++) {
      const root = roots.get(current);
      if (root !== undefined) {
        for (const visited of seen) roots.set(visited, root);
        return root;
      }
      if (seen.has(current)) return undefined;
      seen.add(current);
      const parent = await parentOf(current);
      if (parent === undefined || parent === "") {
        for (const visited of seen) roots.set(visited, current);
        return current;
      }
      current = parent;
    }
    return undefined;
  };
  return async (sessionID) => {
    const known = roots.get(sessionID);
    if (known !== undefined) return known;
    let lookup = pending.get(sessionID);
    if (lookup === undefined) {
      lookup = walk(sessionID).finally(() => pending.delete(sessionID));
      pending.set(sessionID, lookup);
    }
    try {
      return await withTimeout({
        promise: lookup,
        ms: HISTORY_TIMEOUT_MS,
        message: "Session lookup timed out.",
      });
    } catch {
      // A lookup that never settles must not be shared forever: the next
      // review starts a fresh one.
      if (pending.get(sessionID) === lookup) pending.delete(sessionID);
      return undefined;
    }
  };
}

const sessionSchema = z.object({
  id: z.string(),
  parentID: z.optional(z.nullable(z.string())),
});

/** The `parentID` of a session (bare or wrapped in `{data}`), `undefined` for a root. */
export function parentIdentifier(input: unknown): string | undefined {
  const wrapped = z.object({ data: sessionSchema }).safeParse(input);
  const session = wrapped.success ? wrapped.data.data : sessionSchema.safeParse(input).data;
  if (session === undefined) throw new Error("OpenCode did not return the session.");
  return session.parentID ?? undefined;
}

/** What a review should carry, and how to tell whether it went stale. */
type ReviewIntent<Context> = {
  /** True once the person prompted the intent's session after the review began. */
  changed(): boolean;
  /** The root session's intent and conversation, or none when the root is unknown. */
  context(): Promise<Context | UnknownRootContext>;
};

type UnknownRootContext = { conversation?: { turns: never[]; incomplete: true } };

/**
 * Track prompts and hand each review the intent of its root session.
 *
 * Every prompt gets a sequence number. A review records the current number
 * synchronously when it begins, so a prompt in the root session at any point
 * afterwards — even while the root is still being looked up — marks the review
 * as stale.
 */
export function createIntentTracker<Context>(input: {
  rootSession(sessionID: string): Promise<string | undefined>;
  conversation(rootSessionID: string): Promise<Context>;
  conversationEnabled: boolean;
}): {
  prompted(sessionID: string): void;
  begin(sessionID: string): Promise<ReviewIntent<Context>>;
} {
  let sequence = 0;
  const latestPrompt = new Map<string, number>();
  return {
    prompted: (sessionID) => {
      sequence += 1;
      latestPrompt.set(sessionID, sequence);
    },
    begin: async (sessionID) => {
      const start = sequence;
      const root = await input.rootSession(sessionID);
      // Unknown root: the review carries no intent, so only the session's own
      // prompts cancel it (a prompt in the unknown root cannot be matched).
      const intentSession = root ?? sessionID;
      return {
        changed: () => (latestPrompt.get(intentSession) ?? 0) > start,
        context: async () =>
          root === undefined
            ? input.conversationEnabled
              ? { conversation: { turns: [], incomplete: true } }
              : {}
            : input.conversation(root),
      };
    },
  };
}
