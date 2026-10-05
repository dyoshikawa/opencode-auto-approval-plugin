import * as z from "zod/mini";

const reviewerModes = ["on-ask", "all-tools"] as const;

/**
 * `agent` reviews in a read-only OpenCode session, `chat` in one call to an
 * OpenAI-compatible Chat Completions API, `decision` asks a decision model. The rest are deprecated names kept working: `opencode` is `agent`,
 * `decision-model` is `decision`, and `jev` is `decision` with the `typesafe`
 * provider read from `reviewer.jev`.
 */
const reviewerBackends = [
  "agent",
  "chat",
  "decision",
  "opencode",
  "decision-model",
  "jev",
] as const;

const decisionProviders = ["typesafe", "cloudflare"] as const;

type ReviewerMode = (typeof reviewerModes)[number];

type ReviewerBackend = "agent" | "chat" | "decision";

/** What the decision backend does with an operation too large for its model. */
const oversizeActions = ["escalate", "agent", "chat"] as const;

type OversizeAction = (typeof oversizeActions)[number];

export type DecisionProvider = (typeof decisionProviders)[number];

export type ModelReference = {
  providerID: string;
  modelID: string;
};

export type DecisionConfiguration = {
  provider: DecisionProvider;
  apiKey: string;
  /** Full URL of the System One compatible decision endpoint. */
  endpoint: string;
  model: string;
  /** An `allow` below this probability is downgraded to `escalate`. */
  minAllowProbability: number;
  /** The estimated `state` size above which an operation is not sent. */
  maxStateTokens: number;
  onOversize: OversizeAction;
};

export type ChatConfiguration = {
  apiKey: string;
  /** Full URL of the Chat Completions endpoint. */
  endpoint: string;
  model: string;
  /** A whole prompt (instructions and operation) longer than this is not sent. */
  maxInputChars: number;
};

export type PluginConfiguration = {
  mode: ReviewerMode;
  reviewer: {
    backend: ReviewerBackend;
    agent: {
      /** The reviewer session's model; the main session's when unset. */
      model?: ModelReference;
      /** Prompts longer than this escalate unsent. */
      maxInputChars: number;
    };
    timeoutMs: number;
    /** The user's own review policy, added to every review as trusted guidance. */
    instructions?: string;
    /** Whether decision and chat reviews are appended to the usage log. */
    recordUsage: boolean;
    decision?: DecisionConfiguration;
    chat?: ChatConfiguration;
  };
};

type Environment = Record<string, string | undefined>;

const defaultTypeSafeBaseURL = "https://api.typesafe.ai";

const defaultModels: Record<DecisionProvider, string> = {
  typesafe: "jev-latest",
  cloudflare: "clef",
};

// The account ID and the model are interpolated into the Workers AI URL path,
// so both are restricted to characters that cannot change the path.
const cloudflareAccountIDPattern = /^[\da-f]{32}$/;

const cloudflareModelPattern = /^[a-z\d][a-z\d.-]*$/;

const defaultMinAllowProbability = 0.6;

/**
 * Jev refuses a `state` above 32Ki tokens, so 28,000 leaves room for the
 * questions and the estimate. Clef accepts 64Ki but took 46 s for 38k tokens,
 * past the default timeout, so its budget stays where it answered in seconds.
 */
const defaultMaxStateTokens: Record<DecisionProvider, number> = {
  typesafe: 28_000,
  cloudflare: 20_000,
};

/**
 * LLM reviewers have long contexts; this keeps one review to a bounded cost
 * and below what a typical model reads whole.
 */
const defaultMaxLLMInputChars = 400_000;

const defaultChatBaseURL = "https://api.openai.com/v1";

/**
 * Custom instructions are sent with every review (and billed per call with the
 * decision backend), so they are kept to a short policy rather than a document.
 */
const MAX_INSTRUCTIONS_CHARS = 4_000;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const modelReferenceSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const agentOptionsSchema = z.object({
  model: z.optional(modelReferenceSchema),
  maxInputChars: z.optional(z.int().check(z.gte(1_000), z.lte(4_000_000))),
});

const decisionOptionsShape = {
  apiKey: z.optional(z.string()),
  model: z.optional(z.string().check(z.minLength(1))),
  minAllowProbability: z.optional(z.number().check(z.gte(0), z.lte(1))),
  maxStateTokens: z.optional(z.int().check(z.gte(1_000), z.lte(60_000))),
  onOversize: z.optional(z.enum(oversizeActions)),
};

const chatOptionsSchema = z.object({
  apiKey: z.optional(z.string()),
  baseURL: z.optional(z.string()),
  model: z.string().check(z.minLength(1)),
  maxInputChars: z.optional(z.int().check(z.gte(1_000), z.lte(4_000_000))),
});

const typeSafeOptionsSchema = z.object({
  ...decisionOptionsShape,
  baseURL: z.optional(z.string()),
});

const decisionOptionsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("typesafe"), ...typeSafeOptionsSchema.shape }),
  z.object({
    provider: z.literal("cloudflare"),
    ...decisionOptionsShape,
    accountId: z.optional(z.string()),
  }),
]);

const pluginConfigurationSchema = z.object({
  mode: z.optional(z.enum(reviewerModes)),
  reviewer: z.optional(
    z.object({
      backend: z.optional(z.enum(reviewerBackends)),
      agent: z.optional(agentOptionsSchema),
      /** Deprecated: `agent.model`. */
      model: z.optional(modelReferenceSchema),
      timeoutMs: z.optional(z.number().check(z.gte(1), z.lte(120_000))),
      instructions: z.optional(z.union([z.string(), z.array(z.string())])),
      recordUsage: z.optional(z.boolean()),
      // Checked only when the decision backend reads them, so another backend
      // starts whatever they hold. `decisionModel` and `jev` are deprecated.
      decision: z.optional(z.unknown()),
      chat: z.optional(z.unknown()),
      decisionModel: z.optional(z.unknown()),
      jev: z.optional(z.unknown()),
    }),
  ),
});

/**
 * Parses the plugin options, deprecated names included. `env` supplies the
 * decision model credentials
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
  rejectMixedNames(reviewer);
  const backend = normalizedBackend(reviewer?.backend);
  const instructions = reviewerInstructions(reviewer?.instructions);
  const env = input.env ?? process.env;
  const decision = backend === "decision" ? decisionConfiguration({ reviewer, env }) : undefined;
  return {
    mode: result.data.mode ?? "on-ask",
    reviewer: {
      backend,
      agent: agentConfiguration(reviewer),
      timeoutMs: reviewer?.timeoutMs ?? 30_000,
      ...(instructions === undefined ? {} : { instructions }),
      recordUsage: reviewer?.recordUsage ?? true,
      ...(decision === undefined ? {} : { decision }),
      ...(backend === "chat" || decision?.onOversize === "chat"
        ? { chat: chatConfiguration({ options: reviewer?.chat, env }) }
        : {}),
    },
  };
}

/** Maps a backend name, deprecated ones included, to the backend it means. */
function normalizedBackend(
  backend: (typeof reviewerBackends)[number] | undefined,
): ReviewerBackend {
  switch (backend) {
    case undefined:
    case "agent":
    case "opencode":
      return "agent";
    case "chat":
      return "chat";
    case "decision":
    case "decision-model":
    case "jev":
      return "decision";
  }
}

/**
 * Whether the read-only reviewer agent is used: as the backend, or for
 * operations too large for the decision model.
 */
export function usesAgentReviewer(configuration: PluginConfiguration): boolean {
  return (
    configuration.reviewer.backend === "agent" ||
    configuration.reviewer.decision?.onOversize === "agent"
  );
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

type DecisionOptions = z.infer<typeof decisionOptionsSchema>;

/**
 * A key next to its deprecated name fails for every backend, so neither is
 * silently ignored. Only pairs with a new key are checked, so an earlier
 * configuration fails only if it already held a key that had no meaning then.
 */
function rejectMixedNames(reviewer: ReviewerOptions | undefined): void {
  const pairs = [
    [reviewer?.agent?.model, reviewer?.model, "reviewer.model", "reviewer.agent.model"],
    [reviewer?.decision, reviewer?.decisionModel, "reviewer.decisionModel", "reviewer.decision"],
  ] as const;
  for (const [current, deprecated, deprecatedName, replacement] of pairs) {
    if (current !== undefined && deprecated !== undefined) {
      throw new Error(
        `Invalid auto-approval plugin options: ${deprecatedName} is the deprecated name of ${replacement}; set only one.`,
      );
    }
  }
}

/** `agent.model`, or the deprecated `reviewer.model`. */
function agentConfiguration(
  reviewer: ReviewerOptions | undefined,
): PluginConfiguration["reviewer"]["agent"] {
  const model = reviewer?.agent?.model ?? reviewer?.model;
  const maxInputChars = reviewer?.agent?.maxInputChars ?? defaultMaxLLMInputChars;
  return model === undefined ? { maxInputChars } : { model, maxInputChars };
}

/**
 * Resolves `decision`, or one of its deprecated forms: `decisionModel`, or
 * `backend: "jev"` with `jev`. Mixing a form with another fails, so a setting
 * cannot be silently ignored.
 */
function decisionConfiguration(input: {
  reviewer: ReviewerOptions | undefined;
  env: Environment;
}): DecisionConfiguration {
  const reviewer = input.reviewer;
  if (reviewer?.backend === "jev") {
    if (reviewer.decision !== undefined || reviewer.decisionModel !== undefined) {
      throw new Error(
        'Invalid auto-approval plugin options: the deprecated reviewer.backend "jev" reads reviewer.jev only; use reviewer.backend "decision" with reviewer.decision.',
      );
    }
    const jev = parseOptions({
      schema: typeSafeOptionsSchema,
      value: reviewer.jev ?? {},
      prefix: "reviewer.jev",
    });
    return typeSafeConfiguration({
      options: { provider: "typesafe", ...jev },
      env: input.env,
      prefix: "reviewer.jev",
    });
  }
  if (reviewer?.jev !== undefined) {
    throw new Error(
      'Invalid auto-approval plugin options: reviewer.jev is only read with the deprecated reviewer.backend "jev"; move it to reviewer.decision.',
    );
  }
  const prefix =
    reviewer?.decisionModel === undefined ? "reviewer.decision" : "reviewer.decisionModel";
  const value = reviewer?.decision ?? reviewer?.decisionModel;
  if (value === undefined) {
    throw new Error(
      'Invalid auto-approval plugin options: the decision backend needs reviewer.decision with a provider ("typesafe" or "cloudflare").',
    );
  }
  const options = parseOptions({ schema: decisionOptionsSchema, value, prefix });
  return options.provider === "typesafe"
    ? typeSafeConfiguration({ options, env: input.env, prefix })
    : cloudflareConfiguration({ options, env: input.env, prefix });
}

function typeSafeConfiguration(input: {
  options: Extract<DecisionOptions, { provider: "typesafe" }>;
  env: Environment;
  /** Where the options were written, for error messages. */
  prefix: string;
}): DecisionConfiguration {
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
    maxStateTokens: input.options.maxStateTokens ?? defaultMaxStateTokens.typesafe,
    onOversize: input.options.onOversize ?? "escalate",
  };
}

/**
 * Workers AI on the fixed Cloudflare API host. There is no base URL option, so
 * the token can only ever reach api.cloudflare.com; the account ID is not a
 * secret and may come from the options or the environment independently.
 */
function cloudflareConfiguration(input: {
  options: Extract<DecisionOptions, { provider: "cloudflare" }>;
  env: Environment;
  /** Where the options were written, for error messages. */
  prefix: string;
}): DecisionConfiguration {
  const apiKey =
    nonEmpty(input.options.apiKey?.trim()) ?? nonEmpty(input.env.CLOUDFLARE_API_TOKEN?.trim());
  if (apiKey === undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: the cloudflare provider needs ${input.prefix}.apiKey or CLOUDFLARE_API_TOKEN.`,
    );
  }
  // Account IDs are hexadecimal; the dashboard shows them in lowercase.
  const accountID = (
    nonEmpty(input.options.accountId?.trim()) ?? nonEmpty(input.env.CLOUDFLARE_ACCOUNT_ID?.trim())
  )?.toLowerCase();
  if (accountID === undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: the cloudflare provider needs ${input.prefix}.accountId or CLOUDFLARE_ACCOUNT_ID.`,
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
    maxStateTokens: input.options.maxStateTokens ?? defaultMaxStateTokens.cloudflare,
    onOversize: input.options.onOversize ?? "escalate",
  };
}

/**
 * `reviewer.chat`: an OpenAI-compatible Chat Completions API. As with
 * TypeSafe, the key and the base URL come from the same place — the options,
 * or AUTO_APPROVAL_CHAT_API_KEY with AUTO_APPROVAL_CHAT_BASE_URL — so one
 * source cannot send a key supplied by another to its own server.
 */
function chatConfiguration(input: { options: unknown; env: Environment }): ChatConfiguration {
  if (input.options === undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: the chat reviewer needs reviewer.chat with a model.",
    );
  }
  const options = parseOptions({
    schema: chatOptionsSchema,
    value: input.options,
    prefix: "reviewer.chat",
  });
  const optionKey = nonEmpty(options.apiKey?.trim());
  const optionBaseURL = nonEmpty(options.baseURL?.trim());
  if (optionKey === undefined && optionBaseURL !== undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: reviewer.chat.baseURL needs reviewer.chat.apiKey next to it; with AUTO_APPROVAL_CHAT_API_KEY use AUTO_APPROVAL_CHAT_BASE_URL.",
    );
  }
  const source =
    optionKey === undefined
      ? {
          apiKey: nonEmpty(input.env.AUTO_APPROVAL_CHAT_API_KEY?.trim()),
          baseURL: nonEmpty(input.env.AUTO_APPROVAL_CHAT_BASE_URL?.trim()),
        }
      : { apiKey: optionKey, baseURL: optionBaseURL };
  if (source.apiKey === undefined) {
    throw new Error(
      "Invalid auto-approval plugin options: the chat reviewer needs reviewer.chat.apiKey or AUTO_APPROVAL_CHAT_API_KEY.",
    );
  }
  return {
    apiKey: source.apiKey,
    endpoint: chatEndpoint(source.baseURL ?? defaultChatBaseURL),
    model: options.model,
    maxInputChars: options.maxInputChars ?? defaultMaxLLMInputChars,
  };
}

/**
 * OpenAI-compatible base URLs carry a path (`/v1`, `/api/v1`), so unlike the
 * TypeSafe origin a path is kept; credentials, a query or a fragment are not.
 */
function chatEndpoint(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("Invalid auto-approval plugin options: the chat base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error(
      "Invalid auto-approval plugin options: the chat base URL must use HTTPS (HTTP only on a loopback host).",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Invalid auto-approval plugin options: the chat base URL must not carry credentials, a query or a fragment.",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/chat/completions`;
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

/** Parses a nested options object, naming where it sits in the plugin options. */
function parseOptions<T>(input: { schema: z.ZodMiniType<T>; value: unknown; prefix: string }): T {
  const result = z.safeParse(input.schema, input.value);
  if (!result.success) {
    throw new Error(
      `Invalid auto-approval plugin options: ${input.prefix}: ${result.error.message}`,
    );
  }
  return result.data;
}

function nonEmpty(input: string | undefined): string | undefined {
  return input === undefined || input === "" ? undefined : input;
}
