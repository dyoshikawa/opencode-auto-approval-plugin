import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuditingReviewer,
  createAuditLogger,
  MAX_AUDIT_QUEUE_SIZE,
  MAX_COMMAND_INPUT_BYTES,
  redactCommand,
} from "./audit.js";
import type { AuditLogEntry } from "./audit.js";
import { parsePluginConfiguration } from "./config.js";
import type { ReviewRequest } from "./reviewer.js";

const directories: string[] = [];
async function directory() {
  const path = join(process.cwd(), "tmp", "tests", "projects", randomUUID());
  directories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const request: ReviewRequest = {
  source: "tool-call",
  sessionID: "session",
  action: "bash",
  resource: { command: "echo private" },
};
const entry: AuditLogEntry = {
  timestamp: "2026-10-02T00:00:00.000Z",
  backend: "opencode",
  sessionID: "session",
  source: "tool-call",
  action: "bash",
  command: null,
  commandTruncated: false,
  verdict: "allow",
  confidence: null,
  durationMs: 1,
  errorCategory: null,
};

describe("AuditingReviewer", () => {
  it.each(["opencode", "jev"])(
    "wraps %s without interpreting reason text as confidence",
    async (backend) => {
      const log = vi.fn();
      const configuration = parsePluginConfiguration({
        options: {
          auditLog: { enabled: true, path: join(process.cwd(), "tmp", "audit.jsonl") },
          reviewer: { backend, jev: { apiKey: "test-key" } },
        },
      });
      const decision = { verdict: "allow" as const, reason: "confidence 0.99" };
      const reviewer = new AuditingReviewer({
        reviewer: { review: async () => decision, isReviewerSession: () => true },
        configuration,
        logger: { log },
      });
      expect(await reviewer.review(request)).toBe(decision);
      expect(reviewer.isReviewerSession({ sessionID: "session" })).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          backend,
          command: null,
          verdict: "allow",
          confidence: null,
          errorCategory: null,
          durationMs: expect.any(Number),
          timestamp: expect.any(String),
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    },
  );

  it("records structured confidence and only explicit command opt-in", async () => {
    const log = vi.fn();
    const configuration = parsePluginConfiguration({
      options: {
        auditLog: {
          enabled: true,
          includeCommand: true,
          path: join(process.cwd(), "tmp", "audit.jsonl"),
        },
      },
    });
    const reviewer = new AuditingReviewer({
      reviewer: {
        review: async () => ({ verdict: "deny", reason: "secret", confidence: 0.7 }),
        isReviewerSession: () => false,
      },
      configuration,
      logger: { log },
    });
    await reviewer.review({ ...request, resource: { command: "curl --token password" } });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 0.7, command: "curl --token=[REDACTED]" }),
    );
    await reviewer.review({
      ...request,
      source: "permission-request",
      resource: { pattern: "secret command" },
    });
    expect(log.mock.calls[1]?.[0].command).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("keeps errors and decisions unchanged even when logging throws", async () => {
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const failure = new Error("Jev request failed with HTTP 500. secret");
    const review = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ verdict: "allow", reason: "safe" });
    const log = vi.fn<(entry: AuditLogEntry) => void>(() => {
      throw new Error("broken logger");
    });
    const configuration = parsePluginConfiguration({
      options: { auditLog: { enabled: true, path: join(process.cwd(), "tmp", "audit.jsonl") } },
    });
    const reviewer = new AuditingReviewer({
      reviewer: { review, isReviewerSession: () => false },
      configuration,
      logger: { log },
    });
    await expect(reviewer.review(request)).rejects.toBe(failure);
    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
    expect(log.mock.calls[0]?.[0]).toMatchObject({ errorCategory: "http", verdict: null });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("does not log when disabled", async () => {
    const log = vi.fn();
    const reviewer = new AuditingReviewer({
      reviewer: {
        review: async () => ({ verdict: "allow", reason: "safe" }),
        isReviewerSession: () => false,
      },
      configuration: parsePluginConfiguration({ options: {} }),
      logger: { log },
    });
    await reviewer.review(request);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("secure audit file", () => {
  it("creates a private file and tightens an existing file before append", async () => {
    const root = await directory();
    await chmod(root, 0o755);
    const path = join(root, "audit.jsonl");
    const logger = createAuditLogger({ path });
    logger.log(entry);
    await logger.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o666);
    logger.log(entry);
    await logger.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  });

  it("does not follow a pre-placed symlink or change its target", async () => {
    const root = await directory();
    const target = join(root, "target");
    const path = join(root, "link");
    await writeFile(target, "unchanged", { mode: 0o644 });
    await chmod(target, 0o644);
    await symlink(target, path);
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createAuditLogger({ path });
    logger.log(entry);
    await logger.flush();
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("bounds the pending queue and reports bad paths without secrets", async () => {
    const root = await directory();
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createAuditLogger({ path: root });
    for (let index = 0; index < MAX_AUDIT_QUEUE_SIZE + 5; index++) logger.log(entry);
    await logger.flush();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
  });

  it("does not change an approval when the configured path is a directory", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const path = await directory();
    const logger = createAuditLogger({ path });
    const reviewer = new AuditingReviewer({
      reviewer: {
        review: async () => ({ verdict: "allow", reason: "safe" }),
        isReviewerSession: () => false,
      },
      configuration: parsePluginConfiguration({ options: { auditLog: { enabled: true, path } } }),
      logger,
    });
    await expect(reviewer.review(request)).resolves.toEqual({ verdict: "allow", reason: "safe" });
    await logger.flush();
  });
});

describe("best-effort command redaction", () => {
  it("redacts known secrets before limiting output", () => {
    const address = new URL("https://example.com");
    address.username = "user";
    address.password = "pass";
    const command = `TOKEN=secret curl --password hidden ${address.href} configured-key`;
    const result = redactCommand({ command, apiKey: "configured-key" });
    expect(result.command).not.toMatch(/secret|hidden|user:pass|configured-key/);
  });

  it("omits oversized tokens and private keys in full, including multi-byte input", () => {
    for (const command of [
      "TOKEN=" + "x".repeat(MAX_COMMAND_INPUT_BYTES),
      "-----BEGIN PRIVATE KEY-----" + "x".repeat(MAX_COMMAND_INPUT_BYTES),
      "秘".repeat(30_000),
    ]) {
      expect(redactCommand({ command })).toEqual({
        command: "[OMITTED_OVERSIZED_COMMAND]",
        truncated: true,
      });
    }
    expect(redactCommand({ command: "-----BEGIN PRIVATE KEY-----secret" }).command).toBe(
      "[REDACTED_PRIVATE_KEY]",
    );
  });
});
