import * as z from "zod/mini";

const reviewerModes = ["on-ask", "all-tools"] as const;

/** `jev` is the deprecated name of `decision-model` with the `typesafe` provider. */
const reviewerBackends = ["opencode", "decision-model", "jev"] as const;

const decisionModelProviders = ["typesafe", "cloudflare"] as const;

type ReviewerMode = (typeof reviewerModes)[number];

type ReviewerBackend = "opencode" | "decision-model";

export type DecisionModelProvider = (typeof decisionModelProviders)[number];

export type ModelReference = {
  providerID: string;
  modelID: string;
};

export type DecisionModelConfiguration = {
  provider: DecisionModelProvider;
  apiKey: string;
  /** Full URL of the System One compatible decision endpoint. */
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
    /** The user's own review policy, added to every review as trusted guidance. */
    instructions?: string;
    /** Whether decision model reviews are appended to the usage log. */
    recordUsage: boolean;
    decisionModel?: DecisionModelConfiguration;
  };
};

type Environment = Record<string, string | undefined>;

const defaultTypeSafeBaseURL = "https://api.typesafe.ai";

const defaultModels: Record<DecisionModelProvider, string> = {
  typesafe: "jev-latest",
  cloudflare: "clef",
};

// The account ID and the model are interpolated into the Workers AI URL path,
// so both are restricted to characters that cannot change the path.
const cloudflareAccountIDPattern = /^[\da-f]{32}$/;

const cloudflareModelPattern = /^[a-z\d][a-z\d.-]*$/;

const defaultMinAllowProbability = 0.6;

/**
 * Custom instructions are sent with every review (and billed per call with the
 * decision-model backend), so they are kept to a short policy rather than a document.
 */
const MAX_INSTRUCTIONS_CHARS = 4_000;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const modelReferenceSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const decisionModelOptionsShape = {
  apiKey: z.optional(z.string()),
  model: z.optional(z.string().check(z.minLength(1))),
  minAllowProbability: z.optional(z.number().check(z.gte(0), z.lte(1))),
};

const typeSafeOptionsSchema = z.object({
  ...decisionModelOptionsShape,
  baseURL: z.optional(z.string()),
});

const decisionModelOptionsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("typesafe"), ...typeSafeOptionsSchema.shape }),
  z.object({
    provider: z.literal("cloudflare"),
    ...decisionModelOptionsShape,
    accountId: z.optional(z.string()),
  }),
]);

const pluginConfigurationSchema = z.object({
  mode: z.optional(z.enum(reviewerModes)),
  reviewer: z.optional(
    z.object({
      backend: z.optional(z.enum(reviewerBackends)),
      model: z.optional(modelReferenceSchema),
      timeoutMs: z.optional(z.number().check(z.gte(1), z.lte(120_000))),
      instructions: z.optional(z.union([z.string(), z.array(z.string())])),
      recordUsage: z.optional(z.boolean()),
      // Checked only when the decision-model backend reads them, so another
      // backend starts whatever they hold.
      decisionModel: z.optional(z.unknown()),
      jev: z.optional(z.unknown()),
    }),
  ),
});

/**
 * Parses the plugin options. `env` supplies the decision model credentials
 * when the options leave them out; options always take precedence.
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
  const backend: ReviewerBackend =
    reviewer?.backend === undefined || reviewer.backend === "opencode"
      ? "opencode"
      : "decision-model";
  const instructions = reviewerInstructions(reviewer?.instructions);
  const env = input.env ?? process.env;
  return {
    mode: result.data.mode ?? "on-ask",
    reviewer: {
      backend,
      model: reviewer?.model,
      timeoutMs: reviewer?.timeoutMs ?? 30_000,
      ...(instructions === undefined ? {} : { instructions }),
      recordUsage: reviewer?.recordUsage ?? true,
      ...(backend === "decision-model"
        ? { decisionModel: decisionModelConfiguration({ reviewer, env }) }
        : {}),
    },
  };
}

/**
 * Joins the configured instructions into one block. An array is the readable
 * form in JSON, which cannot hold a multi-line string; blank entries are
 * dropped so a list can be commented out line by line.
 */
function reviewerInstructions(input: string | string[] | undefined): string | undefined {
  const lines = (typeof input === "string" ? [input] : (input ?? []))
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return undefined;
  const text = lines.join("\n");
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `Invalid auto-approval plugin options: reviewer.instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters.`,
    );
  }
  return text;
}

type ReviewerOptions = NonNullable<z.infer<typeof pluginConfigurationSchema>["reviewer"]>;

type DecisionModelOptions = z.infer<typeof decisionModelOptionsSchema>;

/** Resolves `decisionModel`, or the deprecated `backend: "jev"` with `jev`. */
function decisionModelConfiguration(input: {
  reviewer: ReviewerOptions | undefined;
  env: Environment;
}): DecisionModelConfiguration {
  const reviewer = input.reviewer;
  if (reviewer?.backend === "jev") {
    if (reviewer.decisionModel !== undefined) {
      throw new Error(
        'Invalid auto-approval plugin options: reviewer.decisionModel needs reviewer.backend "decision-model"; "jev" reads reviewer.jev.',
      );
    }
    const jev = parseOptions({ schema: typeSafeOptionsSchema, value: reviewer.jev ?? {} });
    return typeSafeConfiguration({
      options: { provider: "typesafe", ...jev },
      env: input.env,
      prefix: "reviewer.jev",
    });
  }
  if (reviewer?.jev !== undefined) {
    throw new Error(
      'Invalid auto-approval plugin options: reviewer.jev is only read with the deprecated reviewer.backend "jev"; move it to reviewer.decisionModel.',
    );
  }
  if (reviewer?.decisionModel === undefined) {
    throw new Error(
      'Invalid auto-approval plugin options: the decision-model backend needs reviewer.decisionModel with a provider ("typesafe" or "cloudflare").',
    );
  }
  const options = parseOptions({
    schema: decisionModelOptionsSchema,
    value: reviewer.decisionModel,
  });
  return options.provider === "typesafe"
    ? typeSafeConfiguration({ options, env: input.env, prefix: "reviewer.decisionModel" })
    : cloudflareConfiguration({ options, env: input.env });
}

function typeSafeConfiguration(input: {
  options: Extract<DecisionModelOptions, { provider: "typesafe" }>;
  env: Environment;
  /** Where the options were written, for error messages. */
  prefix: string;
}): DecisionModelConfiguration {
  // The key and the base URL must come from the same place: whoever serves
  // the base URL receives the key and decides every verdict, so one source
  // must not be able to redirect a key supplied by another.
  const optionKey = nonEmpty(input.options.apiKey?.trim());
  const envKey = nonEmpty(input.env.TYPESAFE_API_KEY?.trim());
  const optionBaseURL = nonEmpty(input.options.baseURL?.trim());
  if (optionKey === undefined && optionBaseURL !== undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: ${input.prefix}.baseURL needs ${input.prefix}.apiKey next to it; with TYPESAFE_API_KEY use TYPESAFE_BASE_URL.`,
    );
  }
  const source =
    optionKey === undefined
      ? { apiKey: envKey, baseURL: nonEmpty(input.env.TYPESAFE_BASE_URL?.trim()) }
      : { apiKey: optionKey, baseURL: optionBaseURL };
  const apiKey = source.apiKey;
  if (apiKey === undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: the typesafe provider needs ${input.prefix}.apiKey or TYPESAFE_API_KEY.`,
    );
  }
  return {
    provider: "typesafe",
    apiKey,
    endpoint: typeSafeEndpoint(source.baseURL ?? defaultTypeSafeBaseURL),
    model: input.options.model ?? defaultModels.typesafe,
    minAllowProbability: input.options.minAllowProbability ?? defaultMinAllowProbability,
  };
}

/**
 * Workers AI on the fixed Cloudflare API host. There is no base URL option, so
 * the token can only ever reach api.cloudflare.com; the account ID is not a
 * secret and may come from the options or the environment independently.
 */
function cloudflareConfiguration(input: {
  options: Extract<DecisionModelOptions, { provider: "cloudflare" }>;
  env: Environment;
}): DecisionModelConfiguration {
  const apiKey =
    nonEmpty(input.options.apiKey?.trim()) ?? nonEmpty(input.env.CLOUDFLARE_API_TOKEN?.trim());
  if (apiKey === undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: the cloudflare provider needs reviewer.decisionModel.apiKey or CLOUDFLARE_API_TOKEN.",
    );
  }
  // Account IDs are hexadecimal; the dashboard shows them in lowercase.
  const accountID = (
    nonEmpty(input.options.accountId?.trim()) ?? nonEmpty(input.env.CLOUDFLARE_ACCOUNT_ID?.trim())
  )?.toLowerCase();
  if (accountID === undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: the cloudflare provider needs reviewer.decisionModel.accountId or CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  if (!cloudflareAccountIDPattern.test(accountID)) {
    throw new Error(
      "Invalid auto-approval plugin options: the Cloudflare account ID must be 32 hexadecimal characters.",
    );
  }
  const model = input.options.model ?? defaultModels.cloudflare;
  if (!cloudflareModelPattern.test(model)) {
    throw new Error(
      "Invalid auto-approval plugin options: the Cloudflare model must be a Workers AI model name such as clef-flash.",
    );
  }
  return {
    provider: "cloudflare",
    apiKey,
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountID}/ai/run/@cf/cloudflare/${model}`,
    model,
    minAllowProbability: input.options.minAllowProbability ?? defaultMinAllowProbability,
  };
}

/**
 * The base URL must be a bare HTTP(S) origin: credentials, a query, a fragment
 * or a path would either leak into logs or silently point the reviewer at a
 * different endpoint than the one documented.
 */
function typeSafeEndpoint(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(
      "Invalid auto-approval plugin options: the TypeSafe base URL is not a valid URL.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      "Invalid auto-approval plugin options: the TypeSafe base URL must use HTTP(S).",
    );
  }
  // The bearer token must not cross the network in the clear.
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw new Error(
      "Invalid auto-approval plugin options: the TypeSafe base URL must use HTTPS except on a loopback host.",
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "Invalid auto-approval plugin options: the TypeSafe base URL must be an origin without credentials, path, query or fragment.",
    );
  }
  return new URL("/v1/systemone", url).href;
}

function parseOptions<T>(input: { schema: z.ZodMiniType<T>; value: unknown }): T {
  const result = z.safeParse(input.schema, input.value);
  if (!result.success) {
    throw new Error(`Invalid auto-approval plugin options: ${result.error.message}`);
  }
  return result.data;
}

function nonEmpty(input: string | undefined): string | undefined {
  return input === undefined || input === "" ? undefined : input;
}
