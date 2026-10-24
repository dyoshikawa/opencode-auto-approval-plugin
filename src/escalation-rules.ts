import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { sanitizeReason } from "./reviewer.js";
import { isRecord } from "./shared.js";

/**
 * Operations the reviewer never decides: a matching operation is escalated to
 * a human before any reviewer sees it, whatever the backend would answer.
 */
export type EscalationRule = {
  /** OpenCode permission action or tool name, with `*` and `?` wildcards. */
  action: string;
  /** Matched against every string in the operation; any resource when unset. */
  resource?: string;
};

/** Beyond this many strings an operation escalates rather than go unchecked. */
const maxStrings = 10_000;
const maxDepth = 16;

type CompiledRule = { rule: EscalationRule; action: RegExp; resource?: RegExp };

export class EscalationRulesReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #rules: CompiledRule[];

  constructor(input: { reviewer: Reviewer; rules: EscalationRule[] }) {
    this.#reviewer = input.reviewer;
    this.#rules = input.rules.map((rule) => ({
      rule,
      action: wildcard(rule.action),
      ...(rule.resource === undefined ? {} : { resource: wildcard(rule.resource) }),
    }));
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewer.isReviewerSession(input);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    const match = matchingRule({ rules: this.#rules, request: input });
    if (match === undefined) return this.#reviewer.review(input);
    const reason =
      match === "unchecked"
        ? "The operation is too large to check against the escalate rules; a human must review it."
        : `Matched the escalate rule ${JSON.stringify(match)}; a human must review it.`;
    return { verdict: "escalate", reason: sanitizeReason(reason) };
  }
}

function matchingRule(input: {
  rules: CompiledRule[];
  request: ReviewRequest;
}): EscalationRule | "unchecked" | undefined {
  const rules = input.rules.filter((rule) => rule.action.test(input.request.action));
  if (rules.length === 0) return undefined;
  const unconditional = rules.find((rule) => rule.resource === undefined);
  if (unconditional) return unconditional.rule;
  const strings = stringsOf(input.request.resource);
  if (strings === undefined) return "unchecked";
  return rules.find((rule) => strings.some((value) => rule.resource?.test(value)))?.rule;
}

/**
 * Every string in the operation, with runs of whitespace collapsed so that
 * `git  push` cannot slip past `git push *`. `undefined` when the operation is
 * too large or deep to walk.
 */
function stringsOf(input: unknown): string[] | undefined {
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      strings.push(value.replace(/\s+/g, " ").trim());
      return strings.length <= maxStrings;
    }
    if (!isRecord(value)) return true;
    if (depth >= maxDepth) return false;
    return Object.values(value).every((child) => visit(child, depth + 1));
  };
  return visit(input, 0) ? strings : undefined;
}

/**
 * OpenCode's wildcard syntax: `*` matches anything, `?` one character, and a
 * trailing ` *` also matches the bare command (`git push *` matches
 * `git push`).
 */
function wildcard(pattern: string): RegExp {
  const optionalTail = pattern.endsWith(" *");
  const body = optionalTail ? pattern.slice(0, -2) : pattern;
  const source = [...body]
    .map((character) => {
      if (character === "*") return "[\\s\\S]*";
      if (character === "?") return "[\\s\\S]";
      return character.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}${optionalTail ? "(?: [\\s\\S]*)?" : ""}$`);
}
