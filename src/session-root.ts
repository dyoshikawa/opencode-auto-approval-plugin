import { HISTORY_TIMEOUT_MS } from "./conversation.js";

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
  const resolve = async (sessionID: string): Promise<string | undefined> => {
    const seen = new Set<string>();
    let current = sessionID;
    for (let depth = 0; depth <= MAX_SESSION_DEPTH; depth++) {
      const known = roots.get(current);
      if (known !== undefined) return known;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        resolve(sessionID),
        new Promise<undefined>((done) => {
          timer = setTimeout(() => done(undefined), HISTORY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The review context when the root session is unknown: no user intent, and,
 * when conversation context is on, an empty conversation marked incomplete.
 */
export function unknownRootContext(conversationEnabled: boolean): {
  conversation?: { turns: never[]; incomplete: true };
} {
  return conversationEnabled ? { conversation: { turns: [], incomplete: true } } : {};
}
