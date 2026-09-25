import * as z from "zod/mini";

const reviewerModes = ["on-ask", "all-tools"] as const;

const reviewerBackends = ["opencode", "jev"] as const;

type ReviewerMode = (typeof reviewerModes)[number];

type ReviewerBackend = (typeof reviewerBackends)[number];

export type ModelReference = {
  providerID: string;
  modelID: string;
};

export type JevConfiguration = {
  apiKey: string;
  /** Full URL of the System One decision endpoint. */
  endpoint: string;
  model: string;
  /** An `allow` below this probability is downgraded to `escalate`. */
  minAllowProbability: number;
};

export type PluginConfiguration = {
  mode: ReviewerMode;
  reviewer: {
    backend: ReviewerBackend;
    model?: ModelReference;
    timeoutMs: number;
    jev?: JevConfiguration;
  };
};

type Environment = Record<string, string | undefined>;

const defaultJevBaseURL = "https://api.typesafe.ai";

const defaultJevModel = "jev-latest";

const defaultMinAllowProbability = 0.6;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const modelReferenceSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const jevConfigurationSchema = z.object({
  apiKey: z.optional(z.string()),
  baseURL: z.optional(z.string()),
  model: z.optional(z.string().check(z.minLength(1))),
  minAllowProbability: z.optional(z.number().check(z.gte(0), z.lte(1))),
});

const pluginConfigurationSchema = z.object({
  mode: z.optional(z.enum(reviewerModes)),
  reviewer: z.optional(
    z.object({
      backend: z.optional(z.enum(reviewerBackends)),
      model: z.optional(modelReferenceSchema),
      timeoutMs: z.optional(z.number().check(z.gte(1), z.lte(120_000))),
      jev: z.optional(jevConfigurationSchema),
    }),
  ),
});

/**
 * Parses the plugin options. `env` supplies the Jev credentials when the
 * options leave them out; options always take precedence.
 */
export function parsePluginConfiguration(input: {
  options: unknown;
  env?: Environment;
}): PluginConfiguration {
  const result = z.safeParse(pluginConfigurationSchema, input.options);
  if (!result.success) {
    throw new Error(`Invalid auto-approval plugin options: ${result.error.message}`);
  }

  const reviewer = result.data.reviewer;
  const backend = reviewer?.backend ?? "opencode";
  return {
    mode: result.data.mode ?? "on-ask",
    reviewer: {
      backend,
      model: reviewer?.model,
      timeoutMs: reviewer?.timeoutMs ?? 30_000,
      ...(backend === "jev"
        ? { jev: jevConfiguration({ options: reviewer?.jev, env: input.env ?? process.env }) }
        : {}),
    },
  };
}

function jevConfiguration(input: {
  options: z.infer<typeof jevConfigurationSchema> | undefined;
  env: Environment;
}): JevConfiguration {
  // The key and the base URL must come from the same place: whoever serves
  // the base URL receives the key and decides every verdict, so one source
  // must not be able to redirect a key supplied by another.
  const optionKey = nonEmpty(input.options?.apiKey?.trim());
  const envKey = nonEmpty(input.env.TYPESAFE_API_KEY?.trim());
  if (optionKey === undefined && input.options?.baseURL !== undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: reviewer.jev.baseURL needs reviewer.jev.apiKey next to it; with TYPESAFE_API_KEY use TYPESAFE_BASE_URL.",
    );
  }
  const source =
    optionKey === undefined
      ? { apiKey: envKey, baseURL: nonEmpty(input.env.TYPESAFE_BASE_URL?.trim()) }
      : { apiKey: optionKey, baseURL: input.options?.baseURL };
  const apiKey = source.apiKey;
  if (apiKey === undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: the jev reviewer backend needs reviewer.jev.apiKey or TYPESAFE_API_KEY.",
    );
  }
  const baseURL = source.baseURL ?? defaultJevBaseURL;
  return {
    apiKey,
    endpoint: jevEndpoint(baseURL),
    model: input.options?.model ?? defaultJevModel,
    minAllowProbability: input.options?.minAllowProbability ?? defaultMinAllowProbability,
  };
}

/**
 * The base URL must be a bare HTTP(S) origin: credentials, a query, a fragment
 * or a path would either leak into logs or silently point the reviewer at a
 * different endpoint than the one documented.
 */
function jevEndpoint(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("Invalid auto-approval plugin options: the Jev base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Invalid auto-approval plugin options: the Jev base URL must use HTTP(S).");
  }
  // The bearer token must not cross the network in the clear.
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw new Error(
      "Invalid auto-approval plugin options: the Jev base URL must use HTTPS except on localhost.",
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "Invalid auto-approval plugin options: the Jev base URL must be an origin without credentials, path, query or fragment.",
    );
  }
  return new URL("/v1/systemone", url).href;
}

function nonEmpty(input: string | undefined): string | undefined {
  return input === undefined || input === "" ? undefined : input;
}
