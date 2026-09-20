import * as z from "zod/mini";

const reviewerModes = ["on-ask", "all-tools"] as const;

type ReviewerMode = (typeof reviewerModes)[number];

export type ModelReference = {
  providerID: string;
  modelID: string;
};

export type PluginConfiguration = {
  mode: ReviewerMode;
  reviewer: {
    model?: ModelReference;
    timeoutMs: number;
  } & (
    | { backend: "opencode" }
    | { backend: "jev"; jev: { apiKey: string; endpoint: string; model: string } }
  );
};

const modelReferenceSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const pluginConfigurationSchema = z.object({
  mode: z.optional(z.enum(reviewerModes)),
  reviewer: z.optional(
    z.object({
      backend: z.optional(z.enum(["opencode", "jev"])),
      model: z.optional(modelReferenceSchema),
      timeoutMs: z.optional(z.number().check(z.gte(1), z.lte(120_000))),
      jev: z.optional(z.unknown()),
    }),
  ),
});

export function parsePluginConfiguration(input: unknown): PluginConfiguration {
  const result = z.safeParse(pluginConfigurationSchema, input);
  if (!result.success) {
    throw new Error(`Invalid auto-approval plugin options: ${result.error.message}`);
  }

  const common = {
    model: result.data.reviewer?.model,
    timeoutMs: result.data.reviewer?.timeoutMs ?? 30_000,
  };
  const mode = result.data.mode ?? "on-ask";
  if (result.data.reviewer?.backend !== "jev") {
    return { mode, reviewer: { ...common, backend: "opencode" } };
  }

  // Resolve credentials only for the selected backend, before any review can run.
  const options = z.safeParse(
    z.object({
      apiKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
      baseURL: z.optional(z.string().check(z.trim(), z.minLength(1))),
      model: z.optional(z.string().check(z.trim(), z.minLength(1))),
    }),
    result.data.reviewer.jev ?? {},
  );
  if (!options.success) {
    throw new Error("Invalid auto-approval plugin options: invalid Jev configuration.");
  }
  const apiKey = options.data.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Invalid auto-approval plugin options: Jev requires reviewer.jev.apiKey or TYPESAFE_API_KEY.",
    );
  }
  const baseURL =
    options.data.baseURL ?? (process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai");
  return {
    mode,
    reviewer: {
      ...common,
      backend: "jev",
      jev: {
        apiKey,
        endpoint: resolveJevEndpoint(baseURL),
        model: options.data.model ?? "jev-1.13.0",
      },
    },
  };
}

export function resolveJevEndpoint(rawBaseURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseURL);
  } catch {
    throw new Error("Invalid Jev baseURL: must be a valid absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid Jev baseURL: only http and https are allowed.");
  }
  if (parsed.username || parsed.password || rawBaseURL.includes("?") || rawBaseURL.includes("#")) {
    throw new Error(
      "Invalid Jev baseURL: credentials, query parameters and fragments are not permitted.",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/systemone")) {
    throw new Error("Invalid Jev baseURL: must not include '/v1/systemone'.");
  }
  parsed.pathname = `${path}/v1/systemone`;
  return parsed.toString();
}
