import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as z from "zod/mini";

import { isRecord } from "./shared.js";

/**
 * Imports an optional peer SDK from the configured package directory, or else
 * from where the plugin is installed. OpenCode does not install optional peers
 * with an npm plugin, so most installs need the directory.
 */
export async function importSdk(input: {
  packageName: string;
  /** Where the directory is configured, for error messages. */
  option: string;
  sdkPath?: string;
  /** Imports the package by name; a literal specifier keeps it external to the bundle. */
  importInstalled: () => Promise<unknown>;
  /**
   * The lowest `major.minor.patch` a configured package directory may hold.
   * An older SDK can silently ignore an option the reviewer relies on for
   * safety, so it is refused instead of loaded.
   */
  minimumVersion?: string;
}): Promise<Record<string, unknown>> {
  let module: unknown;
  // Dynamic on purpose: a static import of an optional peer would fail to
  // load the plugin for everyone who does not use this runtime.
  try {
    if (input.sdkPath === undefined) {
      module = await input.importInstalled();
    } else {
      const { entry, version } = await packageEntry({
        directory: input.sdkPath,
        packageName: input.packageName,
      });
      if (input.minimumVersion !== undefined && !atLeast(version, input.minimumVersion)) {
        throw new SdkVersionError(
          `${input.packageName} ${version ?? "(no version)"} from ${input.option} is older than the required ${input.minimumVersion}. Install a newer version.`,
        );
      }
      module = await import(pathToFileURL(entry).href);
    }
  } catch (error) {
    if (error instanceof SdkVersionError) throw error;
    throw new Error(
      input.sdkPath === undefined
        ? `Could not load ${input.packageName}. Install it (npm install -g ${input.packageName}) and set ${input.option} to the installed package directory.`
        : `Could not load ${input.packageName} from ${input.option}.`,
      { cause: error },
    );
  }
  if (!isRecord(module)) {
    throw new Error(`Could not load ${input.packageName}.`);
  }
  return module;
}

class SdkVersionError extends Error {}

function parseVersion(value: string | undefined): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return match === null ? undefined : match.slice(1, 4).map(Number);
}

/** Whether `version`'s `major.minor.patch` is at least `minimum`'s; a missing or unreadable version is not. */
function atLeast(version: string | undefined, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (have === undefined || need === undefined) return false;
  for (const [index, part] of have.entries()) {
    const required = need[index] ?? 0;
    if (part !== required) return part > required;
  }
  return true;
}

const exportTargetSchema = z.union([
  z.string(),
  z.object({ import: z.optional(z.string()), default: z.optional(z.string()) }),
]);

const manifestSchema = z.object({
  name: z.string(),
  version: z.optional(z.string()),
  main: z.optional(z.string()),
  exports: z.optional(z.union([z.string(), z.object({ ".": z.optional(exportTargetSchema) })])),
});

/** The ESM entry point named by the package's own manifest. */
async function packageEntry(input: {
  directory: string;
  packageName: string;
}): Promise<{ entry: string; version: string | undefined }> {
  const manifest = z.safeParse(
    manifestSchema,
    JSON.parse(await readFile(join(input.directory, "package.json"), "utf8")),
  );
  if (!manifest.success || manifest.data.name !== input.packageName) {
    throw new Error(`${input.directory} is not the ${input.packageName} package directory.`);
  }
  const { exports, main, version } = manifest.data;
  const root = typeof exports === "string" ? exports : exports?.["."];
  const entry = typeof root === "string" ? root : (root?.import ?? root?.default ?? main);
  if (entry === undefined) {
    throw new Error(`${input.packageName} at ${input.directory} names no entry point.`);
  }
  return { entry: resolve(input.directory, entry), version };
}
