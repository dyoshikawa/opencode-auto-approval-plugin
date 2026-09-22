import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogEntry } from "./audit.js";
import {
  createAuditLogger,
  extractAuditCommand,
  MAX_AUDIT_QUEUE_SIZE,
  MAX_COMMAND_LENGTH,
  redactCommand,
  resolveAuditLogPath,
} from "./audit.js";

describe("redactCommand", () => {
  it("redacts exact Jev apiKey if provided", () => {
    const apiKey = "typesafe_live_secret_1234567890";
    const result = redactCommand({
      command: `curl -H "x-api-key: ${apiKey}" https://api.typesafe.ai`,
      apiKey,
    });
    expect(result.command).toBe('curl -H "x-api-key: [REDACTED]" https://api.typesafe.ai');
    expect(result.truncated).toBe(false);
  });

  it("redacts HTTP Authorization Bearer, Basic, and token headers", () => {
    const command = [
      'curl -H "Authorization: Bearer header.payload.signature"',
      '-H "Authorization: Basic admin:pass"',
      '-H "Authorization: token github_pat_SYNTHETIC_ONLY_1234567890"',
      "https://example.com",
    ].join(" ");
    const result = redactCommand({ command });
    expect(result.command).toContain("Bearer [REDACTED]");
    expect(result.command).toContain("Basic [REDACTED]");
    expect(result.command).toContain("Authorization: token [REDACTED]");
    expect(result.command).not.toContain("header.payload.signature");
    expect(result.command).not.toContain("admin:pass");
    expect(result.command).not.toContain("github_pat_SYNTHETIC_ONLY_1234567890");
  });

  it("redacts common CLI secret flags with quotes and delimiters", () => {
    const command =
      "docker login --password myPassword123 --api-key=myApiKey456 --token secretToken789";
    const result = redactCommand({ command });
    expect(result.command).toBe(
      "docker login --password [REDACTED] --api-key=[REDACTED] --token [REDACTED]",
    );
  });

  it("redacts environment variable assignments and safely handles mismatched and escaped quotes", () => {
    const command = [
      'export API_KEY="abc12345" DB_PASSWORD=\'secure_pass\' TOKEN="demo\' secret-tail"',
      'UNCLOSED_SECRET="unclosed-value',
      'ESCAPED_TOKEN="val\\"ue"',
      "UNQUOTED_KEY=raw_secret_value; ./run.sh",
    ].join(" && ");
    const result = redactCommand({ command });
    expect(result.command).toContain("API_KEY=[REDACTED]");
    expect(result.command).toContain("DB_PASSWORD=[REDACTED]");
    expect(result.command).toContain("TOKEN=[REDACTED]");
    expect(result.command).toContain("UNCLOSED_SECRET=[REDACTED]");
    expect(result.command).toContain("ESCAPED_TOKEN=[REDACTED]");
    expect(result.command).toContain("UNQUOTED_KEY=[REDACTED]");
    expect(result.command).not.toContain("abc12345");
    expect(result.command).not.toContain("secure_pass");
    expect(result.command).not.toContain("secret-tail");
    expect(result.command).not.toContain("unclosed-value");
    expect(result.command).not.toContain("raw_secret_value");
  });

  it("redacts URL userinfo credentials", () => {
    const command = ["git clone https://user", "secret_pass@example.com/org/repo.git"].join(":");
    const result = redactCommand({ command });
    expect(result.command).toBe("git clone https://user:[REDACTED]@example.com/org/repo.git");
  });

  it("redacts well-known token prefixes", () => {
    const fakeGithubToken = ["ghp", "0123456789abcdef0123456789abcdef0123"].join("_");
    const fakeOpenAiToken = ["sk", "1234567890abcdef12345678"].join("-");
    const command = `echo ${fakeGithubToken} ${fakeOpenAiToken}`;
    const result = redactCommand({ command });
    expect(result.command).toBe("echo [REDACTED_TOKEN] [REDACTED_TOKEN]");
  });

  it("redacts multi-line private key blocks", () => {
    const command = [
      "echo '",
      "-----BEGIN RSA PRIVATE KEY-----",
      "dummy-private-key-data-line-one",
      "dummy-private-key-data-line-two",
      "-----END RSA PRIVATE KEY-----",
      "' > key.pem",
    ].join("\n");
    const result = redactCommand({ command });
    expect(result.command).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result.command).not.toContain("dummy-private-key-data");
  });

  it("truncates commands exceeding MAX_COMMAND_LENGTH and marks truncated true", () => {
    const longCommand = "a".repeat(MAX_COMMAND_LENGTH + 100);
    const result = redactCommand({ command: longCommand });
    expect(result.command.length).toBe(MAX_COMMAND_LENGTH);
    expect(result.truncated).toBe(true);
  });
});

describe("extractAuditCommand", () => {
  it.each([{ pattern: ["curl *"] }, { resources: ["curl *"] }])(
    "redacts metadata commands for either permission shape",
    (shape) => {
      const resource = {
        ...shape,
        metadata: { command: "curl --password private-value https://example.com" },
      };
      expect(
        extractAuditCommand({
          source: "permission-request",
          action: "bash",
          resource,
          includeCommand: true,
        }),
      ).toEqual({
        command: "curl --password [REDACTED] https://example.com",
        commandTruncated: false,
      });
      expect(
        extractAuditCommand({
          source: "permission-request",
          action: "bash",
          resource,
          includeCommand: false,
        }).command,
      ).toBeNull();
      expect(
        extractAuditCommand({
          source: "permission-request",
          action: "read",
          resource,
          includeCommand: true,
        }).command,
      ).toBeNull();
    },
  );
  it("returns null when includeCommand is false", () => {
    const result = extractAuditCommand({
      source: "tool-call",
      action: "bash",
      resource: { command: "ls -la" },
      includeCommand: false,
    });
    expect(result).toEqual({ command: null, commandTruncated: false });
  });

  it("returns null for permission-request even with pattern or command-like fields", () => {
    const result = extractAuditCommand({
      source: "permission-request",
      action: "bash",
      resource: { pattern: "rm -rf /" },
      includeCommand: true,
    });
    expect(result).toEqual({ command: null, commandTruncated: false });
  });

  it("returns null for non-bash tool calls", () => {
    const result = extractAuditCommand({
      source: "tool-call",
      action: "read",
      resource: { path: "secret.txt" },
      includeCommand: true,
    });
    expect(result).toEqual({ command: null, commandTruncated: false });
  });

  it("extracts and redacts command for bash tool calls", () => {
    const result = extractAuditCommand({
      source: "tool-call",
      action: "bash",
      resource: { command: "curl -H 'Authorization: Bearer secret_token' https://api.com" },
      includeCommand: true,
    });
    expect(result.command).toBe("curl -H 'Authorization: Bearer [REDACTED]' https://api.com");
    expect(result.commandTruncated).toBe(false);
  });
});

describe("resolveAuditLogPath", () => {
  it("resolves relative path against plugin directory regardless of different cwd", () => {
    const pluginDirectory = join(process.cwd(), "tmp", "tests", "projects", "plugin-dir");
    const path = resolveAuditLogPath({
      configuredPath: "custom/audit.jsonl",
      pluginDirectory,
    });
    expect(path).toBe(join(pluginDirectory, "custom", "audit.jsonl"));
    expect(path).not.toBe(join(process.cwd(), "custom", "audit.jsonl"));
  });

  it("preserves absolute path", () => {
    const path = resolveAuditLogPath({
      configuredPath: "/var/log/audit.jsonl",
      pluginDirectory: "/app/plugin",
    });
    expect(path).toBe("/var/log/audit.jsonl");
  });

  it("prioritizes OPENCODE_DATA_DIR override when specified", () => {
    vi.stubEnv("OPENCODE_DATA_DIR", "/custom/override/data");
    const path = resolveAuditLogPath({ pluginDirectory: "/app/plugin" });
    expect(path).toBe(join("/custom/override/data", "logs", "approval-audit.jsonl"));
    vi.unstubAllEnvs();
  });

  it("uses XDG_DATA_HOME when set", () => {
    vi.stubEnv("OPENCODE_DATA_DIR", "");
    vi.stubEnv("XDG_DATA_HOME", "/custom/xdg/data");
    const path = resolveAuditLogPath({ pluginDirectory: "/app/plugin" });
    expect(path).toBe(join("/custom/xdg/data", "opencode", "logs", "approval-audit.jsonl"));
    vi.unstubAllEnvs();
  });

  it("falls back to standard ~/.local/share/opencode when no env vars are set", () => {
    vi.stubEnv("OPENCODE_DATA_DIR", "");
    vi.stubEnv("XDG_DATA_HOME", "");
    const path = resolveAuditLogPath({ pluginDirectory: "/app/plugin" });
    expect(path).toBe(
      join(homedir(), ".local", "share", "opencode", "logs", "approval-audit.jsonl"),
    );
    vi.unstubAllEnvs();
  });
});

describe("createAuditLogger", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(process.cwd(), "tmp", "tests", "projects", randomUUID());
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  const sampleEntry: AuditLogEntry = {
    timestamp: "2026-09-20T12:00:00.000Z",
    backend: "jev",
    model: "jev-1.13.0",
    sessionID: "ses_123",
    source: "tool-call",
    action: "bash",
    command: "ls -la",
    commandTruncated: false,
    verdict: "allow",
    confidence: 0.98,
    durationMs: 45,
    errorCategory: null,
  };

  it("performs zero I/O and creates no files when disabled", async () => {
    const logPath = join(testDir, "audit.jsonl");
    const logger = createAuditLogger({ enabled: false, logPath });
    logger.log({ entry: sampleEntry });

    // Allow any potential microtasks to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(logPath)).toBe(false);
  });

  it("appends valid JSONL entries when enabled", async () => {
    const logPath = join(testDir, "logs", "audit.jsonl");
    const logger = createAuditLogger({ enabled: true, logPath });

    logger.log({ entry: sampleEntry });
    logger.log({
      entry: {
        ...sampleEntry,
        verdict: "deny",
        command: "rm -rf /",
        confidence: 0.12,
      },
    });

    // Wait for fire-and-forget I/O to flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(logPath)).toBe(true);
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      backend: "jev",
      sessionID: "ses_123",
      verdict: "allow",
      confidence: 0.98,
    });

    const second = JSON.parse(lines[1]!);
    expect(second).toMatchObject({
      verdict: "deny",
      command: "rm -rf /",
      confidence: 0.12,
    });
  });

  it("handles write failure gracefully without throwing or crashing", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Point to an invalid path that cannot be created (e.g., file as parent dir)
    const invalidPath = join(testDir, "\0invalid", "audit.jsonl");
    const logger = createAuditLogger({ enabled: true, logPath: invalidPath });

    expect(() => logger.log({ entry: sampleEntry })).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stderrSpy).toHaveBeenCalledWith(
      "auto-approval-plugin: failed to write audit log entry\n",
    );
    stderrSpy.mockRestore();
  });

  it("drops entries and emits a single warning when write queue exceeds maximum capacity", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logPath = join(testDir, "queue-test", "audit.jsonl");
    const logger = createAuditLogger({ enabled: true, logPath });

    for (let index = 0; index < MAX_AUDIT_QUEUE_SIZE + 10; index++) {
      logger.log({ entry: { ...sampleEntry, sessionID: `ses_${index}` } });
    }

    expect(stderrSpy).toHaveBeenCalledWith(
      "auto-approval-plugin: audit log queue full, dropping entries\n",
    );
    const warningCalls = stderrSpy.mock.calls.filter(
      (call) => call[0] === "auto-approval-plugin: audit log queue full, dropping entries\n",
    );
    expect(warningCalls).toHaveLength(1);
    stderrSpy.mockRestore();
  });
});
