import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { isRecord } from "./shared.js";

/**
 * Which permission asks name a filesystem path the operation will actually
 * open, and whether that path exists. A `read` ask names the requested path,
 * an `external_directory` ask names the resolved target, and a `grep` or
 * `glob` ask names its search anchor. Every other action carries shell
 * patterns, non-filesystem resources or no single path — including the
 * not-yet-existing output paths that are legitimate — so its payload is never
 * stat'ed.
 */

export type PermissionAsk = {
  action: string;
  resources: ReadonlyArray<string>;
  metadata?: Record<string, unknown>;
};

const pathTargetedActions = new Set(["read", "external_directory", "grep", "glob"]);

/** Characters that make a string a glob rather than a concrete path. */
const globMetacharacters = /[*?[{]/;

/**
 * The concrete paths an ask targets, empty when the ask targets no path the
 * guard may stat.
 *
 * `grep` and `glob` resources are the query (a regex, a glob), never a path,
 * so only the tool's anchor argument in `metadata.path` counts for them. An
 * ask without an anchor searches the session's directory, which exists, and
 * resolves to no candidate.
 */
export function targetedPaths(ask: PermissionAsk): string[] {
  if (!pathTargetedActions.has(ask.action)) return [];
  if (ask.action === "grep" || ask.action === "glob") {
    return nonEmptyStrings([ask.metadata?.path]);
  }
  const resources = nonEmptyStrings(ask.resources);
  if (resources.length > 0 || ask.action !== "external_directory") return resources;
  // Older V2 asks carry the external target in the metadata instead.
  return nonEmptyStrings([ask.metadata?.filepath, ask.metadata?.parentDir]);
}

/**
 * The concrete paths a tool call targets, empty when its arguments name none
 * the guard may stat. A `read` call names the file it reads in `filePath`; a
 * `grep` or `glob` call names its search anchor in `path` and falls back to
 * the session directory when that is absent, which exists.
 */
export function toolTargets(input: { tool: string; input: unknown }): string[] {
  if (!isRecord(input.input)) return [];
  if (input.tool === "read") return nonEmptyStrings([input.input.filePath]);
  if (input.tool === "grep" || input.tool === "glob") {
    return nonEmptyStrings([input.input.path]);
  }
  return [];
}

/**
 * The path to name in a denial that skips the review, or `undefined` when the
 * operation must keep its reviewer. Only a target whose every candidate path
 * is missing is denied: one existing path, a glob-shaped target, or a stat
 * failure other than ENOENT or ENOTDIR (permissions, a symlink loop, a
 * malformed path) keeps the regular review flow, so the guard can never deny
 * an operation the reviewer would have judged. Relative targets resolve
 * against the instance directory, the base the file tools resolve their own
 * arguments against.
 *
 * Never throws: every failure mode resolves to `undefined`.
 */
export async function missingTarget(input: {
  directory: string;
  candidates: string[];
}): Promise<string | undefined> {
  if (input.candidates.length === 0) return undefined;
  let missing: string | undefined;
  for (const candidate of input.candidates) {
    if (globMetacharacters.test(candidate)) return undefined;
    const target = isAbsolute(candidate) ? candidate : join(input.directory, candidate);
    if ((await pathExistence(target)) !== "missing") return undefined;
    missing ??= target;
  }
  return missing;
}

async function pathExistence(path: string): Promise<"exists" | "missing" | "ambiguous"> {
  try {
    await stat(path);
    return "exists";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "ambiguous";
  }
}

function nonEmptyStrings(values: readonly unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
}
