import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import * as z from "zod/mini";

import { formatStats, inRange, type StatsRange, summarize } from "./stats.js";
import { projectID, type UsageRecord, usageLogPath, usageRecordSchema } from "./usage.js";

const usage = `Usage: opencode-auto-approval-plugin stats [flags]

Show token usage and cost of decision model reviews (Jev, Clef).

Flags:
  --days <n>         Show the last N days; 0 means today
  --year <yyyy>      Show a calendar year
  --all              Show lifetime statistics
  --project <dir>    Only reviews of one project; "." for the current directory
  --json             Output statistics as JSON
  --file <path>      Read another usage log (default: ${usageLogPath()})
  -h, --help         Show this help
`;

export async function main(input: {
  argv: string[];
  now?: Date;
  write?: (text: string) => void;
  /** Errors and usage after a mistake, kept off stdout so `--json` stays parseable. */
  writeError?: (text: string) => void;
}): Promise<number> {
  const write = input.write ?? ((text: string) => process.stdout.write(text));
  const writeError = input.writeError ?? ((text: string) => process.stderr.write(text));
  let parsed;
  try {
    parsed = parseArgs({
      args: input.argv,
      allowPositionals: true,
      options: {
        days: { type: "string" },
        year: { type: "string" },
        all: { type: "boolean" },
        project: { type: "string" },
        json: { type: "boolean" },
        file: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    write(usage);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "stats") {
    writeError(usage);
    return 2;
  }

  const now = input.now ?? new Date();
  const range = statsRange({ values, now });
  if (typeof range === "string") {
    writeError(`${range}\n\n${usage}`);
    return 2;
  }
  const project =
    values.project === undefined ? undefined : projectID({ directory: values.project });
  const path = values.file ?? usageLogPath();
  let log: UsageRecord[];
  try {
    log = await readUsageLog({ path });
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    writeError(`Cannot read the usage log ${path} (${reason}).\n`);
    return 1;
  }
  const records = log.filter(
    (record) =>
      inRange({ record, range, now }) && (project === undefined || record.project === project),
  );
  const stats = summarize({ records, range, now });
  write(
    values.json
      ? `${JSON.stringify(stats, null, 2)}\n`
      : formatStats({ stats, ...(project === undefined ? {} : { project }) }),
  );
  return 0;
}

function statsRange(input: {
  values: { days?: string; year?: string; all?: boolean };
  now: Date;
}): StatsRange | string {
  const chosen = [input.values.days, input.values.year, input.values.all].filter(
    (value) => value !== undefined && value !== false,
  );
  if (chosen.length > 1) return "Use only one of --days, --year and --all.";
  if (input.values.all) return { kind: "all" };
  if (input.values.days !== undefined) {
    return /^\d{1,5}$/.test(input.values.days)
      ? { kind: "days", days: Number(input.values.days) }
      : "--days needs a whole number of days.";
  }
  if (input.values.year !== undefined) {
    return /^\d{4}$/.test(input.values.year)
      ? { kind: "year", year: Number(input.values.year) }
      : "--year needs a four-digit year.";
  }
  return { kind: "year", year: input.now.getFullYear() };
}

/** Reads the log line by line; a missing file is an empty log and bad lines are skipped. */
async function readUsageLog(input: { path: string }): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const stream = createReadStream(input.path, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const record = z.safeParse(usageRecordSchema, value);
      if (record.success) records.push(record.data);
    }
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return records;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
