import type { UsageRecord } from "./usage.js";

export type StatsRange =
  | { kind: "days"; days: number }
  | { kind: "year"; year: number }
  | { kind: "all" };

type ModelStats = {
  provider: string;
  model: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  unpriced: number;
  medianLatencyMs: number;
};

export type UsageStats = {
  range: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /** Reviews whose cost is unknown: an unpriced model or no token count. */
  unpriced: number;
  verdicts: Record<UsageRecord["verdict"], number>;
  models: ModelStats[];
};

/** Today and the N calendar days before it (0 = today only), a calendar year, or everything. */
export function inRange(input: { record: UsageRecord; range: StatsRange; now: Date }): boolean {
  const time = new Date(input.record.time);
  if (Number.isNaN(time.getTime())) return false;
  switch (input.range.kind) {
    case "all":
      return true;
    case "year":
      return time.getFullYear() === input.range.year;
    case "days": {
      const start = new Date(input.now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - input.range.days);
      return time >= start;
    }
  }
}

function describeRange(input: { range: StatsRange; now: Date }): string {
  switch (input.range.kind) {
    case "all":
      return "all time";
    case "year":
      return input.range.year === input.now.getFullYear()
        ? `${input.range.year} so far`
        : String(input.range.year);
    case "days":
      if (input.range.days === 0) return "today";
      return input.range.days === 1
        ? "today and yesterday"
        : `today and the ${input.range.days} days before`;
  }
}

export function summarize(input: {
  records: UsageRecord[];
  range: StatsRange;
  now: Date;
}): UsageStats {
  const verdicts = { allow: 0, deny: 0, escalate: 0, error: 0 };
  const groups = new Map<string, UsageRecord[]>();
  for (const record of input.records) {
    verdicts[record.verdict] += 1;
    const key = `${record.provider}\u0000${record.model}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [record]);
    else group.push(record);
  }
  const models = [...groups.values()]
    .map((records) => modelStats(records))
    .toSorted((a, b) => b.reviews - a.reviews);
  return {
    range: describeRange({ range: input.range, now: input.now }),
    reviews: input.records.length,
    inputTokens: sum(models.map((model) => model.inputTokens)),
    outputTokens: sum(models.map((model) => model.outputTokens)),
    costUSD: sum(models.map((model) => model.costUSD)),
    unpriced: sum(models.map((model) => model.unpriced)),
    verdicts,
    models,
  };
}

function modelStats(records: UsageRecord[]): ModelStats {
  const [first] = records;
  const latencies = records.map((record) => record.latencyMs).toSorted((a, b) => a - b);
  return {
    provider: first?.provider ?? "",
    model: first?.model ?? "",
    reviews: records.length,
    inputTokens: sum(records.map((record) => record.inputTokens ?? 0)),
    outputTokens: sum(records.map((record) => record.outputTokens ?? 0)),
    costUSD: sum(records.map((record) => record.costUSD ?? 0)),
    unpriced: records.filter((record) => record.costUSD === null).length,
    medianLatencyMs: median(latencies),
  };
}

/** The middle value of sorted numbers, averaging the two middle ones. */
function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function formatStats(input: { stats: UsageStats; project?: string }): string {
  const { stats } = input;
  const header = `auto-approval stats · ${stats.range} · ${input.project === undefined ? "all projects" : "this project"}`;
  if (stats.reviews === 0) {
    return `${header}\n\nno decision model reviews in this range\n`;
  }
  const rows = [
    ["provider", "model", "reviews", "tokens in", "tokens out", "cost", "p50 latency"],
    ...stats.models.map((model) => [
      printable(model.provider),
      printable(model.model),
      integer(model.reviews),
      tokens(model.inputTokens),
      tokens(model.outputTokens),
      dollars(model.costUSD),
      `${integer(model.medianLatencyMs)} ms`,
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const table = rows.map((row) =>
    row
      .map((cell, column) =>
        // Text columns align left, numbers right.
        column < 2 ? cell.padEnd(widths?.[column] ?? 0) : cell.padStart(widths?.[column] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
  const percent = (count: number) => `${Math.round((count / stats.reviews) * 100)}%`;
  const verdicts = (["allow", "escalate", "deny", "error"] as const)
    .map((verdict) => `${verdict} ${percent(stats.verdicts[verdict])}`)
    .join(" · ");
  const unpriced =
    stats.unpriced === 0
      ? ""
      : `\n${integer(stats.unpriced)} review(s) without a price (unknown model or no token count) are not in the cost.`;
  return [
    header,
    "",
    `reviews ${integer(stats.reviews)}   tokens ${tokens(stats.inputTokens)} in / ${tokens(stats.outputTokens)} out   cost ${dollars(stats.costUSD)}`,
    "",
    ...table,
    "",
    `verdicts  ${verdicts}${unpriced}`,
    "",
  ].join("\n");
}

/**
 * The log may come from elsewhere (`--file`); a control character in a model
 * name must not reach the terminal as an escape sequence.
 */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

function integer(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return integer(value);
}

function dollars(value: number): string {
  // A review costs a few hundred-thousandths of a dollar; keep them visible.
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(2)}`;
}
