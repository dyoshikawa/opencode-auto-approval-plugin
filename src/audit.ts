import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { isRecord } from "./shared.js";

export type AuditLogEntry = {
  timestamp: string;
  backend: "jev" | "opencode";
  model: string | null;
  sessionID: string;
  source: "permission-request" | "tool-call";
  action: string;
  command: string | null;
  commandTruncated: boolean;
  verdict: "allow" | "deny" | "escalate" | null;
  confidence: number | null;
  durationMs: number;
  errorCategory:
    | "timeout"
    | "network"
    | "http"
    | "invalid-json"
    | "invalid-response"
    | "session-error"
    | "internal"
    | null;
};

export type AuditLogger = {
  log(input: { entry: AuditLogEntry }): void;
};

export const MAX_COMMAND_LENGTH = 2048;
export const MAX_AUDIT_QUEUE_SIZE = 1000;

/**
 * Redacts sensitive tokens, keys, passwords, and userinfo from shell commands
 * on a best-effort basis, and caps the result at MAX_COMMAND_LENGTH characters.
 */
export function redactCommand(input: { command: string; apiKey?: string }): {
  command: string;
  truncated: boolean;
} {
  let text = input.command;

  // Redact private key blocks completely
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );

  // Exact match of configured Jev API key if available
  if (input.apiKey && input.apiKey.trim().length > 0) {
    const escaped = input.apiKey.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "g"), "[REDACTED_KEY]");
  }

  // Authorization / Auth headers (e.g. Authorization: Bearer ..., Authorization: token ..., X-API-Key: ...)
  text = text.replace(
    /((?:Authorization|Proxy-Authorization|X-API-Key|X-Auth-Token):?\s*(?:Bearer|Basic|Token|Key)?\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s,;'"]+)/gi,
    "$1[REDACTED]",
  );

  // Standalone Bearer / Basic / Token keywords followed by credential
  text = text.replace(
    /\b(Bearer|Basic|Token)\s+(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[A-Za-z0-9._~+/-]+=*)/gi,
    "$1 [REDACTED]",
  );

  // Common CLI flags for passwords, secrets, and API keys.
  // Handles paired double/single quotes with escape support and unclosed quotes up to shell delimiters.
  text = text.replace(
    /(--(?:password|token|api-key|secret|auth|apikey))([=\s]+)(?:"(?:[^"\\;&|\n\r]|\\.)*(?:"|$)|'(?:[^'\\;&|\n\r]|\\.)*(?:'|$)|[^\s;&|]+)/gi,
    "$1$2[REDACTED]",
  );

  // Environment variable assignments with sensitive names.
  // Explicitly handles paired double/single quotes with escape support,
  // unquoted values until delimiter, and unclosed quotes conservatively up to shell delimiters.
  text = text.replace(
    /\b((?:[A-Za-z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)(?:_[A-Za-z0-9_]*)?)=(?:"(?:[^"\\;&|\n\r]|\\.)*(?:"|$)|'(?:[^'\\;&|\n\r]|\\.)*(?:'|$)|[^\s;&|]+)/gi,
    "$1=[REDACTED]",
  );

  // URL userinfo credentials (e.g., https://user:pass@host)
  text = text.replace(/((?:https?|ftp|ssh):\/\/[^:\s/]+):[^@\s/]+@/gi, "$1:[REDACTED]@");

  // Common well-known token formats
  text = text.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9-_]{20,}|typesafe_[A-Za-z0-9-_]{20,}|glpat-[A-Za-z0-9-_]{20,})\b/gi,
    "[REDACTED_TOKEN]",
  );

  const truncated = text.length > MAX_COMMAND_LENGTH;
  const command = truncated ? text.slice(0, MAX_COMMAND_LENGTH) : text;

  return { command, truncated };
}

/**
 * Extracts only actual bash commands; permission patterns are never executable evidence.
 */
export function extractAuditCommand(input: {
  source: "permission-request" | "tool-call";
  action: string;
  resource: unknown;
  includeCommand: boolean;
  apiKey?: string;
}): { command: string | null; commandTruncated: boolean } {
  if (!input.includeCommand) {
    return { command: null, commandTruncated: false };
  }

  if (input.action === "bash" && isRecord(input.resource)) {
    const source = input.source === "tool-call" ? input.resource : input.resource.metadata;
    if (isRecord(source) && typeof source.command === "string") {
      const redacted = redactCommand({ command: source.command, apiKey: input.apiKey });
      return { command: redacted.command, commandTruncated: redacted.truncated };
    }
  }

  return { command: null, commandTruncated: false };
}

/**
 * Resolves the audit log path based on user configuration, falling back to the standard
 * OpenCode user data directory across all platforms ($XDG_DATA_HOME/opencode or ~/.local/share/opencode).
 * Relative paths are resolved against the plugin directory.
 */
export function resolveAuditLogPath(input: {
  configuredPath?: string;
  pluginDirectory: string;
}): string {
  if (input.configuredPath && input.configuredPath.trim().length > 0) {
    const trimmed = input.configuredPath.trim();
    return isAbsolute(trimmed) ? trimmed : join(input.pluginDirectory, trimmed);
  }

  // Optional plugin environment override: OPENCODE_DATA_DIR
  if (process.env.OPENCODE_DATA_DIR && process.env.OPENCODE_DATA_DIR.trim().length > 0) {
    return join(process.env.OPENCODE_DATA_DIR.trim(), "logs", "approval-audit.jsonl");
  }

  // Standard OpenCode data directory across all platforms:
  // $XDG_DATA_HOME/opencode or ~/.local/share/opencode
  const dataDir = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(homedir(), ".local", "share", "opencode");

  return join(dataDir, "logs", "approval-audit.jsonl");
}

export function createAuditLogger(input: { enabled: boolean; logPath: string }): AuditLogger {
  if (!input.enabled) {
    return {
      log: () => {
        // Zero I/O when audit log is disabled
      },
    };
  }

  const queue: string[] = [];
  let isProcessing = false;
  let dirEnsured = false;
  let warnedDrop = false;
  let warnedWriteError = false;

  async function processQueue(): Promise<void> {
    if (isProcessing) return;
    isProcessing = true;

    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length).join("");
      try {
        if (!dirEnsured) {
          await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
          dirEnsured = true;
        }
        await appendFile(input.logPath, batch, { mode: 0o600, flag: "a" });
      } catch {
        if (!warnedWriteError) {
          process.stderr.write("auto-approval-plugin: failed to write audit log entry\n");
          warnedWriteError = true;
        }
      }
    }

    isProcessing = false;
  }

  return {
    log: ({ entry }) => {
      if (queue.length >= MAX_AUDIT_QUEUE_SIZE) {
        if (!warnedDrop) {
          process.stderr.write("auto-approval-plugin: audit log queue full, dropping entries\n");
          warnedDrop = true;
        }
        return;
      }

      queue.push(`${JSON.stringify(entry)}\n`);
      void processQueue();
    },
  };
}
