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
  /** Matched against every string value in the operation; any resource when unset. */
  resource?: string;
};

/** Beyond this many strings an operation escalates rather than go unchecked. */
const maxStrings = 10_000;
const maxDepth = 16;

export class EscalationRulesReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #rules: EscalationRule[];

  constructor(input: { reviewer: Reviewer; rules: EscalationRule[] }) {
    this.#reviewer = input.reviewer;
    // Patterns get the same whitespace folding as the strings they match.
    this.#rules = input.rules.map((rule) => ({
      action: rule.action.toLowerCase(),
      ...(rule.resource === undefined ? {} : { resource: normalized(rule.resource) }),
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

/** The first rule, in configuration order, that matches the operation. */
function matchingRule(input: {
  rules: EscalationRule[];
  request: ReviewRequest;
}): EscalationRule | "unchecked" | undefined {
  const action = input.request.action.toLowerCase();
  let strings: string[] | undefined;
  for (const rule of input.rules) {
    if (!matchesWildcard({ value: action, pattern: rule.action })) continue;
    const { resource } = rule;
    if (resource === undefined) return rule;
    strings ??= stringsOf(checkedPart(input.request));
    if (strings === undefined) return "unchecked";
    if (strings.some((value) => matchesWildcard({ value, pattern: resource }))) return rule;
  }
  return undefined;
}

/**
 * What a rule's resource is matched against: a permission request's
 * resources or patterns (its metadata holds diffs and other derived text),
 * or the whole tool input.
 */
function checkedPart(request: ReviewRequest): unknown {
  if (request.source !== "permission-request" || !isRecord(request.resource)) {
    return request.resource;
  }
  const { metadata: _metadata, ...rest } = request.resource;
  return rest;
}

/**
 * Matching ignores case (paths on case-insensitive file systems, URL hosts),
 * shell line continuations and how much whitespace separates words; folding
 * more than needed only escalates more.
 */
function normalized(value: string): string {
  return value
    .replace(/\\\r?\n/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Every string value in the operation, normalized like the patterns.
 * `undefined` when the operation is too large or deep to walk.
 */
function stringsOf(input: unknown): string[] | undefined {
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      strings.push(normalized(value));
      return strings.length <= maxStrings;
    }
    if (!isRecord(value)) return true;
    if (depth >= maxDepth) return false;
    return Object.values(value).every((child) => visit(child, depth + 1));
  };
  return visit(input, 0) ? strings : undefined;
}

/**
 * OpenCode's wildcard syntax: `*` matches anything, `?` one character, the
 * whole value must match, and a trailing ` *` also matches the bare command
 * (`git push *` matches `git push`). Matched segment by segment, never
 * through a regular expression, so a long value cannot make it backtrack;
 * the cost is bounded by the value's length times the pattern's.
 */
export function matchesWildcard(input: { value: string; pattern: string }): boolean {
  if (input.pattern.endsWith(" *") && matchesGlob(input.value, input.pattern.slice(0, -2))) {
    return true;
  }
  return matchesGlob(input.value, input.pattern);
}

function matchesGlob(value: string, pattern: string): boolean {
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  if (segments.length === 1) return value.length === first.length && segmentAt(value, first, 0);
  const last = segments.at(-1) ?? "";
  if (value.length < first.length + last.length) return false;
  if (!segmentAt(value, first, 0) || !segmentAt(value, last, value.length - last.length)) {
    return false;
  }
  // Leftmost placement of each middle segment is always safe for `*`.
  let position = first.length;
  const end = value.length - last.length;
  for (const segment of segments.slice(1, -1)) {
    const found = findSegment({ value, segment, from: position, end });
    if (found === -1) return false;
    position = found + segment.length;
  }
  return true;
}

/** Whether `segment` (`?` = any one character) matches `value` at `index`. */
function segmentAt(value: string, segment: string, index: number): boolean {
  if (index < 0 || index + segment.length > value.length) return false;
  for (let offset = 0; offset < segment.length; offset++) {
    const expected = segment[offset];
    if (expected !== "?" && expected !== value[index + offset]) return false;
  }
  return true;
}

/** The first index in `[from, end - segment.length]` where `segment` matches. */
function findSegment(input: { value: string; segment: string; from: number; end: number }): number {
  const { value, segment, from, end } = input;
  if (!segment.includes("?")) {
    const index = value.indexOf(segment, from);
    return index !== -1 && index + segment.length <= end ? index : -1;
  }
  for (let index = from; index + segment.length <= end; index++) {
    if (segmentAt(value, segment, index)) return index;
  }
  return -1;
}
