// cspell:words apikey pousr glpat
import type { ConversationContext } from "./conversation.js";
import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { isRecord } from "./shared.js";

/**
 * Replaces common credentials in a log line: the reviewer API keys in use,
 * private keys, authorization headers, `--password`-style flags,
 * `*_TOKEN=`-style assignments, URL user info and well-known token formats.
 * Best-effort, and generous: an unterminated quote or key block is redacted
 * to the end, since a log is never read to decide anything. Never use it on
 * what a reviewer judges; see `redactForReview`.
 */
export function redactSecrets(input: { text: string; apiKeys?: string[] }): string {
  let text = input.text;
  for (const apiKey of input.apiKeys ?? []) {
    if (apiKey) text = text.split(apiKey).join("[REDACTED_KEY]");
  }
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /((?:Authorization|Proxy-Authorization|X-API-Key|X-Auth-Token):?\s*(?:Bearer|Basic|Token|Key)?\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;'"\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic|Token)\s+[^\s;'"\r\n]+/gi, "$1 [REDACTED]")
    .replace(
      /(--(?:password|token|api-key|secret|auth|apikey))[=\s]+(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s;&|]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b((?:[A-Za-z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)(?:_[A-Za-z0-9_]*)?)=(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s;&|]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/((?:https?|ftp|ssh):\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(wellKnownTokens, "[REDACTED_TOKEN]");
}

const wellKnownTokens =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|typesafe_[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gi;

/**
 * Characters a credential value is made of. No whitespace, quote, `$`,
 * backtick, bracket or shell operator: whatever `redactForReview` replaces
 * cannot contain a command, so the reviewer always sees what would run.
 */
const token = "[A-Za-z0-9._~+/=:@%,!-]";
const tokenOnly = new RegExp(`^${token}+$`);
const secretName = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)S?(?:_|$)/i;

/**
 * Replaces credentials in what a reviewer is shown, conservatively: only
 * values made of credential characters (see `token`), never across a quote,
 * space or shell syntax, so crafted text cannot make it hide part of an
 * operation. Every quantifier is bounded, so it runs in linear time.
 */
export function redactForReview(input: {
  text: string;
  apiKeys: string[];
  patterns: RegExp[];
}): string {
  let text = input.text;
  for (const apiKey of input.apiKeys) {
    if (apiKey.length >= 8) text = text.split(apiKey).join("[REDACTED_KEY]");
  }
  for (const pattern of input.patterns) {
    text = text.replace(pattern, (match) => (tokenOnly.test(match) ? "[REDACTED]" : match));
  }
  return text
    .replace(
      /-----BEGIN ([A-Z ]{0,40})PRIVATE KEY-----[A-Za-z0-9+/=\s]{1,100000}?-----END \1PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      new RegExp(
        `\\b((?:Proxy-)?Authorization|X-API-Key|X-Auth-Token)(:?[ \\t]{0,8})((?:Bearer|Basic|Token|Key)[ \\t]{1,8})?${token}{8,4096}(?!${token})`,
        "gi",
      ),
      (_match, name: string, separator: string, scheme: string | undefined) =>
        `${name}${separator}${scheme ?? ""}[REDACTED]`,
    )
    .replace(
      new RegExp(`\\b(Bearer|Basic)[ \\t]{1,8}${token}{8,4096}(?!${token})`, "gi"),
      "$1 [REDACTED]",
    )
    .replace(
      new RegExp(
        `(--(?:password|token|api-key|secret|auth|apikey))([= ])(["']?)${token}{1,4096}\\3(?!${token})`,
        "gi",
      ),
      "$1$2$3[REDACTED]$3",
    )
    .replace(
      new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]{0,63})=(["']?)${token}{1,4096}\\2(?!${token})`, "g"),
      (match, name: string, quote: string) =>
        secretName.test(name) ? `${name}=${quote}[REDACTED]${quote}` : match,
    )
    .replace(
      /((?:https?|ftp|ssh):\/\/)[A-Za-z0-9._~%+-]{1,256}(?::[A-Za-z0-9._~%+-]{0,256})?@/gi,
      "$1[REDACTED]@",
    )
    .replace(wellKnownTokens, "[REDACTED_TOKEN]");
}

/**
 * Hands the reviewer a copy of the operation, the user's intent and the
 * conversation with credentials replaced, so they never reach a model
 * provider. The original objects are never changed: they are the live tool
 * input OpenCode runs.
 */
export class RedactingReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #redact: (text: string) => string;

  constructor(input: { reviewer: Reviewer; apiKeys: string[]; patterns: RegExp[] }) {
    this.#reviewer = input.reviewer;
    this.#redact = (text) =>
      redactForReview({ text, apiKeys: input.apiKeys, patterns: input.patterns });
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewer.isReviewerSession(input);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    return this.#reviewer.review({
      ...input,
      resource: redactedCopy({ value: input.resource, redact: this.#redact }),
      ...(input.userIntent === undefined ? {} : { userIntent: this.#redact(input.userIntent) }),
      ...(input.conversation === undefined
        ? {}
        : {
            conversation: redactedConversation({
              conversation: input.conversation,
              redact: this.#redact,
            }),
          }),
    });
  }
}

function redactedConversation(input: {
  conversation: ConversationContext;
  redact: (text: string) => string;
}): ConversationContext {
  return {
    ...input.conversation,
    turns: input.conversation.turns.map((turn) => ({ ...turn, text: input.redact(turn.text) })),
  };
}

/**
 * A deep copy of plain JSON-like data with every string redacted. Anything
 * else (a Date, a Buffer) is passed as it is; tool input is parsed JSON.
 */
function redactedCopy(input: { value: unknown; redact: (text: string) => string }): unknown {
  const { value, redact } = input;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactedCopy({ value: item, redact }));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactedCopy({ value: item, redact })]),
  );
}
