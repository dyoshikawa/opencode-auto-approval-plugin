import type { PluginConfiguration } from "./config.js";
import type { Reviewer, ReviewSessionClient } from "./reviewer.js";

export type PluginDependencies = {
  createReviewer(input: {
    client: ReviewSessionClient;
    configuration: PluginConfiguration;
  }): Reviewer;
};

export function textFromParts(parts: unknown[]): string {
  return parts
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

export function errorMessage(input: unknown): string {
  return input instanceof Error ? input.message : String(input);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
