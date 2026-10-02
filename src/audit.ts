// cspell:words apikey pousr glpat
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type { PluginConfiguration } from "./config.js";
import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { isRecord } from "./shared.js";

export const MAX_COMMAND_INPUT_BYTES = 65_536;
export const MAX_COMMAND_LENGTH = 2_048;
export const MAX_AUDIT_QUEUE_SIZE = 1_000;

export type AuditLogEntry = {
  timestamp: string;
  backend: "opencode" | "jev";
  sessionID: string;
  source: ReviewRequest["source"];
  action: string;
  command: string | null;
  commandTruncated: boolean;
  verdict: ReviewVerdict["verdict"] | null;
  confidence: number | null;
  durationMs: number;
  errorCategory: "timeout" | "http" | "network" | "invalid-response" | "reviewer-error" | null;
};

export type AuditLogger = { log(entry: AuditLogEntry): void };

function classifyError(error: unknown): AuditLogEntry["errorCategory"] {
  const message = error instanceof Error ? error.message : "";
  if (/timed out/i.test(message)) return "timeout";
  if (/HTTP \d+/.test(message)) return "http";
  if (message === "Jev request failed.") return "network";
  if (/JSON|verdict schema/.test(message)) return "invalid-response";
  return "reviewer-error";
}

/** Best-effort only. Never redact a prefix of oversized input: a cut token could leak. */
export function redactCommand(input: { command: string; apiKey?: string }): {
  command: string;
  truncated: boolean;
} {
  if (
    input.command.length > MAX_COMMAND_INPUT_BYTES ||
    Buffer.byteLength(input.command, "utf8") > MAX_COMMAND_INPUT_BYTES
  ) {
    return { command: "[OMITTED_OVERSIZED_COMMAND]", truncated: true };
  }
  let text = input.command;
  if (input.apiKey) text = text.split(input.apiKey).join("[REDACTED_KEY]");
  text = text
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
  return {
    command: text.slice(0, MAX_COMMAND_LENGTH),
    truncated: text.length > MAX_COMMAND_LENGTH,
  };
}

function commandForAudit(input: {
  request: ReviewRequest;
  configuration: PluginConfiguration;
}): Pick<AuditLogEntry, "command" | "commandTruncated"> {
  const { request, configuration } = input;
  if (
    configuration.auditLog.includeCommand &&
    request.action === "bash" &&
    isRecord(request.resource)
  ) {
    const resource = request.source === "tool-call" ? request.resource : request.resource.metadata;
    if (isRecord(resource) && typeof resource.command === "string") {
      const redacted = redactCommand({
        command: resource.command,
        apiKey: configuration.reviewer.jev?.apiKey,
      });
      return { command: redacted.command, commandTruncated: redacted.truncated };
    }
  }
  return { command: null, commandTruncated: false };
}

/** Logging is outside the backend, never changes a decision and never blocks approval on I/O. */
export class AuditingReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #configuration: PluginConfiguration;
  readonly #logger: AuditLogger;
  #warnedLogger = false;

  constructor(input: {
    reviewer: Reviewer;
    configuration: PluginConfiguration;
    logger: AuditLogger;
  }) {
    this.#reviewer = input.reviewer;
    this.#configuration = input.configuration;
    this.#logger = input.logger;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewer.isReviewerSession(input);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    if (!this.#configuration.auditLog.enabled) return this.#reviewer.review(input);
    const start = performance.now();
    let decision: ReviewVerdict | undefined;
    let errorCategory: AuditLogEntry["errorCategory"] = null;
    try {
      decision = await this.#reviewer.review(input);
      return decision;
    } catch (error) {
      // Do not persist error text or cause chains, which can contain credentials.
      errorCategory = classifyError(error);
      throw error;
    } finally {
      try {
        this.#logger.log({
          timestamp: new Date().toISOString(),
          backend: this.#configuration.reviewer.backend,
          sessionID: input.sessionID.slice(0, 256),
          source: input.source,
          action: input.action.slice(0, 256),
          ...commandForAudit({ request: input, configuration: this.#configuration }),
          verdict: decision?.verdict ?? null,
          confidence:
            typeof decision?.confidence === "number" && Number.isFinite(decision.confidence)
              ? decision.confidence
              : null,
          durationMs: Math.round(performance.now() - start),
          errorCategory,
        });
      } catch {
        // Even an injected logger must not turn an allow into an error or hide a backend failure.
        if (!this.#warnedLogger) {
          process.stderr.write("auto-approval-plugin: audit logger failed; entries may be lost\n");
          this.#warnedLogger = true;
        }
      }
    }
  }
}

/** Local best-effort JSONL; a bounded queue can drop records, and is not a durable approval ledger. */
export function createAuditLogger(input: {
  path: string;
}): AuditLogger & { flush(): Promise<void> } {
  const queue: string[] = [];
  let processing: Promise<void> | undefined;
  let warnedWrite = false;
  let warnedDrop = false;

  async function drain(): Promise<void> {
    while (queue.length) {
      const line = queue.shift()!;
      try {
        // Windows does not offer these POSIX guarantees. Do not silently weaken them.
        if (process.platform === "win32" || !constants.O_NOFOLLOW)
          throw new Error("Secure audit file opening unavailable.");
        await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
        const file = await open(
          input.path,
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_WRONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error("Audit target is not a private regular file.");
          await file.chmod(0o600);
          if (((await file.stat()).mode & 0o777) !== 0o600)
            throw new Error("Audit permissions unavailable.");
          await file.writeFile(line);
        } finally {
          await file.close();
        }
      } catch {
        if (!warnedWrite) {
          process.stderr.write(
            "auto-approval-plugin: secure audit write failed; entries may be lost\n",
          );
          warnedWrite = true;
        }
      }
    }
  }

  function startDrain(): void {
    processing ??= drain().finally(() => {
      processing = undefined;
      if (queue.length) startDrain();
    });
  }

  return {
    log(entry) {
      if (queue.length >= MAX_AUDIT_QUEUE_SIZE) {
        if (!warnedDrop) {
          process.stderr.write("auto-approval-plugin: audit queue full; dropping entries\n");
          warnedDrop = true;
        }
        return;
      }
      queue.push(`${JSON.stringify(entry)}\n`);
      startDrain();
    },
    async flush() {
      let pending = processing;
      while (pending) {
        await pending;
        pending = processing;
      }
    },
  };
}
