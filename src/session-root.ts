import * as z from "zod/mini";

import { HISTORY_TIMEOUT_MS } from "./conversation.js";
import { withTimeout } from "./shared.js";

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
  /** The intent's session and conversation, or none when the intent is unknown. */
  context(): Promise<Context | UnknownRootContext>;
};

type UnknownRootContext = { conversation?: { turns: never[]; incomplete: true } };

/** What one review reads from a session's conversation. */
export type ConversationContextRequest = {
  /** The prompt this review answers; overrides the session's latest prompt. */
  latest?: string;
  /** Drop turns after `latest`, so a later prompt cannot read as its context. */
  truncateAtLatest?: boolean;
};

/**
 * The prompt that authorized a delegation. A `task`-tool subagent acts under
 * the prompt that spawned it, so every review in its branch uses that prompt
 * even after the person has moved on in the root session.
 */
type DelegationIntent = { text: string };

/** How many prompts per session are kept for binding a branch's delegation. */
const PROMPT_HISTORY_LIMIT = 32;

/**
 * Track prompts and hand each review the intent that authorizes it.
 *
 * A root session's review uses its latest prompt. A subagent's review uses the
 * root prompt that was current when its branch started: every descendant of
 * that branch reuses the same binding, so a later unrelated prompt in the root
 * neither authorizes nor invalidates the delegated work.
 *
 * Every prompt gets a sequence number. A review records the current number
 * synchronously when it begins, so a prompt in the intent's root session or in
 * the reviewed session itself at any point afterwards — even while the root is
 * still being looked up — marks the review as stale.
 */
export function createIntentTracker<Context>(input: {
  rootSession(sessionID: string): Promise<string | undefined>;
  parentSession(sessionID: string): Promise<string | undefined>;
  conversation(sessionID: string, request?: ConversationContextRequest): Promise<Context>;
  conversationEnabled: boolean;
}): {
  prompted(sessionID: string, text: string): void;
  begin(sessionID: string): Promise<ReviewIntent<Context>>;
} {
  let sequence = 0;
  const latestPrompt = new Map<string, number>();
  const prompts = new Map<string, Array<{ sequence: number; text: string }>>();
  const firstPrompt = new Map<string, number>();
  const delegations = new Map<string, DelegationIntent>();
  const pending = new Map<string, Promise<DelegationIntent | undefined>>();

  const prompted = (sessionID: string, text: string) => {
    sequence += 1;
    latestPrompt.set(sessionID, sequence);
    const history = prompts.get(sessionID) ?? [];
    history.push({ sequence, text });
    if (history.length > PROMPT_HISTORY_LIMIT) history.shift();
    prompts.set(sessionID, history);
    if (!firstPrompt.has(sessionID)) firstPrompt.set(sessionID, sequence);
  };

  /**
   * The sessions between `sessionID` and the root, nearest first, as far as
   * the chain can be read. A cycle, a failed lookup or excessive depth stops
   * the walk; the root resolver still fails closed on its own.
   */
  const ancestors = async (sessionID: string): Promise<string[]> => {
    const chain: string[] = [];
    const seen = new Set<string>([sessionID]);
    let current: string | undefined;
    try {
      current = await input.parentSession(sessionID);
      while (
        current !== undefined &&
        current !== "" &&
        chain.length < MAX_SESSION_DEPTH &&
        !seen.has(current)
      ) {
        seen.add(current);
        chain.push(current);
        current = await input.parentSession(current);
      }
    } catch {
      // Keep whatever part of the chain was read.
    }
    return chain;
  };

  const findDelegation = async (sessionID: string): Promise<DelegationIntent | undefined> => {
    const chain = await ancestors(sessionID);
    // Descendants of one delegation share its authority; the nearest binding wins.
    for (const ancestor of chain) {
      const inherited = delegations.get(ancestor);
      if (inherited !== undefined) {
        delegations.set(sessionID, inherited);
        return inherited;
      }
    }
    const root = await input.rootSession(sessionID);
    if (root === undefined || root === sessionID) return undefined;
    // The branch began with its highest session that is not the root itself;
    // bind the root prompt that was current then, never one the person wrote
    // afterwards.
    const branch = chain.filter((session) => session !== root);
    const branchHead = branch.at(-1) ?? sessionID;
    const first = firstPrompt.get(branchHead) ?? firstPrompt.get(sessionID);
    if (first === undefined) return undefined;
    const entry = (prompts.get(root) ?? []).findLast((prompt) => prompt.sequence <= first);
    if (entry === undefined) return undefined;
    const delegation = { text: entry.text };
    delegations.set(sessionID, delegation);
    return delegation;
  };

  const delegationFor = async (sessionID: string): Promise<DelegationIntent | undefined> => {
    const known = delegations.get(sessionID);
    if (known !== undefined) return known;
    let lookup = pending.get(sessionID);
    if (lookup === undefined) {
      lookup = findDelegation(sessionID).finally(() => pending.delete(sessionID));
      pending.set(sessionID, lookup);
    }
    return lookup;
  };

  return {
    prompted,
    begin: async (sessionID) => {
      const start = sequence;
      const root = await input.rootSession(sessionID);
      // Unknown root: the review carries no intent, so only the session's own
      // prompts cancel it (a prompt in the unknown root cannot be matched).
      const intentSession = root ?? sessionID;
      const delegation =
        root === undefined || root === sessionID ? undefined : await delegationFor(sessionID);
      return {
        changed: () =>
          (latestPrompt.get(intentSession) ?? 0) > start ||
          (delegation !== undefined && (latestPrompt.get(sessionID) ?? 0) > start),
        context: async () => {
          if (root === undefined) {
            return input.conversationEnabled
              ? { conversation: { turns: [], incomplete: true } }
              : {};
          }
          if (delegation !== undefined) {
            return input.conversation(root, {
              latest: delegation.text,
              truncateAtLatest: true,
            });
          }
          return input.conversation(root);
        },
      };
    },
  };
}
