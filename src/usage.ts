import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as z from "zod/mini";

import type { DecisionModelProvider } from "./config.js";

/**
 * One line of the usage log: what a decision model review cost. It never holds
 * the operation, the prompt or the reason — only numbers and identifiers.
 */
export const usageRecordSchema = z.object({
  v: z.literal(1),
  time: z.string(),
  provider: z.string(),
  model: z.string(),
  /**
   * A hash of the project directory; `stats --project` hashes the same way. It
   * keeps the path out of the file but is not a secret: a guessed path can be
   * hashed and matched.
   */
  project: z.string(),
  inputTokens: z.nullable(z.number()),
  outputTokens: z.nullable(z.number()),
  latencyMs: z.number(),
  verdict: z.enum(["allow", "deny", "escalate", "error"]),
  /** Priced when the review ran; `null` for a model without a known price. */
  costUSD: z.nullable(z.number()),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** Receives one record per review. It must never throw into the review. */
export type UsageRecorder = (record: UsageRecord) => void;

type Environment = Record<string, string | undefined>;

const cloudflarePrices = new Map([
  ["clef", 0.24],
  ["clef-flash", 0.09],
]);

/**
 * Input prices in USD per million tokens, as published on 2026-10-04. Output
 * tokens are free on both APIs (Clef reports none).
 */
const inputPricePerMillion: Record<DecisionModelProvider, (model: string) => number | undefined> = {
  typesafe: (model) => (model.startsWith("jev") ? 0.042 : undefined),
  cloudflare: (model) => cloudflarePrices.get(model),
};

const officialEndpoints: Record<DecisionModelProvider, string> = {
  typesafe: "https://api.typesafe.ai/",
  cloudflare: "https://api.cloudflare.com/",
};

/** The cost at the published price; `null` when it is unknown, as for a self-hosted endpoint. */
export function costUSD(input: {
  provider: DecisionModelProvider;
  endpoint: string;
  model: string;
  inputTokens: number | null;
}): number | null {
  if (!input.endpoint.startsWith(officialEndpoints[input.provider])) return null;
  const price = inputPricePerMillion[input.provider](input.model);
  if (price === undefined || input.inputTokens === null) return null;
  return (input.inputTokens * price) / 1_000_000;
}

export function usageLogPath(input: { env?: Environment } = {}): string {
  const env = input.env ?? process.env;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode-auto-approval-plugin", "usage.jsonl");
}

export function projectID(input: { directory: string }): string {
  return createHash("sha256").update(resolve(input.directory)).digest("hex").slice(0, 16);
}

/**
 * Appends to a JSON Lines file. Each record is one short `O_APPEND` write, so
 * concurrent OpenCode processes do not interleave lines. A failure to write is
 * dropped: the log is a convenience and must not block a review.
 */
export function fileUsageRecorder(input: { path: string }): UsageRecorder {
  let ready: Promise<unknown> | undefined;
  return (record) => {
    ready ??= mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
    void ready
      .then(() => appendFile(input.path, `${JSON.stringify(record)}\n`, { mode: 0o600 }))
      .catch(() => {
        // Retry the directory next time: it may have been removed or fixed.
        ready = undefined;
      });
  };
}
