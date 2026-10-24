// cspell:words apikey pousr glpat
import type { ConversationContext } from "./conversation.js";
import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { isRecord } from "./shared.js";

/**
 * Replaces common credentials in `text`: the reviewer API keys in use,
 * private keys, authorization headers, `--password`-style flags,
 * `*_TOKEN=`-style assignments, URL user info and well-known token formats.
 * Best-effort only.
 */
export function redactSecrets(input: {
  text: string;
  apiKeys?: string[];
  patterns?: RegExp[];
}): string {
  let text = input.text;
  for (const apiKey of input.apiKeys ?? []) {
    if (apiKey) text = text.split(apiKey).join("[REDACTED_KEY]");
  }
  for (const pattern of input.patterns ?? []) {
    text = text.replace(pattern, "[REDACTED]");
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
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|typesafe_[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gi,
      "[REDACTED_TOKEN]",
    );
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
      redactSecrets({ text, apiKeys: input.apiKeys, patterns: input.patterns });
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

/** A deep copy with every string redacted; other values are kept as they are. */
function redactedCopy(input: { value: unknown; redact: (text: string) => string }): unknown {
  const { value, redact } = input;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactedCopy({ value: item, redact }));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactedCopy({ value: item, redact })]),
  );
}
