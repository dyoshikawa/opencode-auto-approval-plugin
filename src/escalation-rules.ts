// cspell:words oldstring newstring patchtext
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

/** Beyond these an operation escalates rather than go unchecked. */
const maxStrings = 10_000;
const maxDepth = 16;
const maxCandidateCharacters = 1_000_000;

/** A rule as matched, next to the rule as configured for the reason. */
type NormalizedRule = {
  rule: EscalationRule;
  action: (value: string) => boolean;
  resource?: (value: string) => boolean;
};

export class EscalationRulesReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #rules: NormalizedRule[];

  constructor(input: { reviewer: Reviewer; rules: EscalationRule[] }) {
    this.#reviewer = input.reviewer;
    // Patterns get the same folding as the strings they match.
    this.#rules = input.rules.map((rule) => ({
      rule,
      action: wildcardMatcher(rule.action.toLowerCase()),
      ...(rule.resource === undefined
        ? {}
        : { resource: wildcardMatcher(normalized(rule.resource)) }),
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
  rules: NormalizedRule[];
  request: ReviewRequest;
}): EscalationRule | "unchecked" | undefined {
  const action = input.request.action.toLowerCase();
  let candidates: string[] | "unchecked" | undefined;
  for (const rule of input.rules) {
    if (!rule.action(action)) continue;
    const { resource } = rule;
    if (resource === undefined) return rule.rule;
    candidates ??= candidatesOf(input.request);
    if (candidates === "unchecked") return candidates;
    if (candidates.some(resource)) return rule.rule;
  }
  return undefined;
}

/** Built-in file tools whose content keys say what is written, not where. */
const fileTools = new Set(["write", "edit", "multiedit"]);
const contentKeys = new Set(["content", "oldstring", "newstring"]);
/**
 * Derived text in a permission request's metadata — diffs (`diff`, and the
 * `patch` of each entry in `files`), contents and previews — not where or how.
 */
const metadataContentKeys = new Set([
  "diff",
  "patch",
  "before",
  "after",
  "content",
  "oldstring",
  "newstring",
  "preview",
  "output",
]);
/** Built-in patch tools, matched through the file paths their headers name. */
const patchTools = new Set(["apply_patch", "patch"]);
// OpenCode trims a header line before reading it, so leading whitespace is allowed;
// never a line break, which would make the scan quadratic over blank lines.
const patchPath = /^[^\S\r\n]*\*\*\* (?:add file|update file|delete file|move to): (.+)$/gim;
/** Words: a path or flag stays one candidate whatever quotes or operators wrap it. */
const separators = /[\s"'`;|&<>(){}=]+/;

/**
 * What a rule's resource is matched against, normalized and de-duplicated.
 * Every string value — a permission request's resources, patterns and
 * metadata (except the diffs and previews in it; older OpenCode 1.x asks
 * carry the path only as `metadata.filePath`), every string in a tool
 * input — is matched as
 * a whole, line by line and word by word, with two exceptions for built-in
 * tools: the contents a `write`, `edit` or `multiedit` writes are skipped (a
 * path rule must not fire on code that mentions `process.env`), and an
 * `apply_patch` / `patch` patch is matched through the file paths its
 * headers name.
 *
 * `"unchecked"` when the operation is too large or deep to walk.
 */
function candidatesOf(request: ReviewRequest): string[] | "unchecked" {
  const permission = request.source === "permission-request";
  const tool = permission ? "" : request.action.toLowerCase();
  const candidates = new Set<string>();
  let strings = 0;
  let characters = 0;
  const add = (value: string) => {
    const folded = normalized(value);
    if (folded === "" || candidates.has(folded)) return;
    candidates.add(folded);
    characters += folded.length;
  };
  const addAll = (value: string) => {
    add(value);
    for (const line of withoutContinuations(value).split(/\r?\n/)) {
      add(line);
      for (const word of line.split(separators)) add(word);
    }
  };
  const skipped = (key: string, inMetadata: boolean): boolean =>
    inMetadata ? metadataContentKeys.has(key) : fileTools.has(tool) && contentKeys.has(key);
  const visit = (value: unknown, key: string, depth: number, inMetadata: boolean): boolean => {
    if (typeof value === "string") {
      strings++;
      if (patchTools.has(tool) && key === "patchtext") {
        for (const match of value.matchAll(patchPath)) add(match[1] ?? "");
      } else if (!skipped(key, inMetadata)) {
        addAll(value);
      }
      return strings <= maxStrings && characters <= maxCandidateCharacters;
    }
    if (!isRecord(value)) return true;
    if (depth >= maxDepth) return false;
    return Object.entries(value).every(([child, item]) =>
      visit(
        item,
        Array.isArray(value) ? key : child.toLowerCase(),
        depth + 1,
        inMetadata || (permission && depth === 0 && child === "metadata"),
      ),
    );
  };
  return visit(request.resource, "", 0, false) ? [...candidates] : "unchecked";
}

/**
 * Matching ignores case (paths on case-insensitive file systems, URL hosts),
 * shell line continuations and how much whitespace separates words; folding
 * more than needed only escalates more.
 */
function withoutContinuations(value: string): string {
  return value.replace(/\\\r?\n/g, "");
}

function normalized(value: string): string {
  return withoutContinuations(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * OpenCode's wildcard syntax: `*` matches anything, `?` one character, the
 * whole value must match, and a trailing ` *` also matches the bare command
 * (`git push *` matches `git push`). Matched segment by segment, never
 * through a regular expression, so a long value cannot make it backtrack;
 * the cost is bounded by the value's length times the pattern's.
 */
export function matchesWildcard(input: { value: string; pattern: string }): boolean {
  return wildcardMatcher(input.pattern)(input.value);
}

/** `matchesWildcard` with the pattern split once. */
function wildcardMatcher(pattern: string): (value: string) => boolean {
  const full = globMatcher(pattern);
  if (!pattern.endsWith(" *")) return full;
  const bare = globMatcher(pattern.slice(0, -2));
  return (value) => bare(value) || full(value);
}

function globMatcher(pattern: string): (value: string) => boolean {
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  if (segments.length === 1) {
    return (value) => value.length === first.length && segmentAt(value, first, 0);
  }
  const last = segments.at(-1) ?? "";
  const middle = segments.slice(1, -1);
  return (value) => {
    if (value.length < first.length + last.length) return false;
    if (!segmentAt(value, first, 0) || !segmentAt(value, last, value.length - last.length)) {
      return false;
    }
    // Leftmost placement of each middle segment is always safe for `*`.
    let position = first.length;
    const end = value.length - last.length;
    for (const segment of middle) {
      const found = findSegment({ value, segment, from: position, end });
      if (found === -1) return false;
      position = found + segment.length;
    }
    return true;
  };
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
