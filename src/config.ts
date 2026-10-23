import { isAbsolute } from "node:path";

import * as z from "zod/mini";

import { estimateTokens } from "./reviewer.js";

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

/**
 * Where the agent reviewer runs: a read-only OpenCode session, Claude Code
 * through the Claude Agent SDK, or Codex through the Codex SDK.
 */
const agentRuntimes = ["opencode", "claude-agent-sdk", "codex-sdk"] as const;

/** The runtimes driven through an SDK, and the option holding each one's package directory. */
const sdkRuntimes = {
  "claude-agent-sdk": { option: "claudeAgentSdk", example: "claude-sonnet-5-5" },
  "codex-sdk": { option: "codexSdk", example: "gpt-5.6-codex" },
} as const;

type SdkRuntime = keyof typeof sdkRuntimes;

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
  /**
   * `typesafe` only: operations above `maxStateTokens` and up to this budget
   * are sent with TypeSafe's long-context header instead of being too large.
   */
  longContext?: LongContextConfiguration;
  onOversize: OversizeAction;
};

export type LongContextConfiguration = {
  /** The estimated `state` size above which even a long-context request is not sent. */
  maxStateTokens: number;
  /** An `allow` from a long-context request below this probability is downgraded to `escalate`. */
  minAllowProbability: number;
};

/**
 * `openai-compatible` posts to any Chat Completions endpoint; `openai` and
 * `anthropic` call the vendor's own API on a fixed host with its own key.
 */
const chatProviders = ["openai-compatible", "openai", "anthropic"] as const;

export type ChatProvider = (typeof chatProviders)[number];

export type ChatConfiguration = {
  provider: ChatProvider;
  apiKey: string;
  /** Full URL of the Chat Completions endpoint, or Anthropic's Messages endpoint. */
  endpoint: string;
  model: string;
  /** A whole prompt (instructions and operation) longer than this, in UTF-8 bytes, is not sent. */
  maxInputBytes: number;
};

type AgentConfiguration = {
  /** Prompts longer than this, in UTF-8 bytes, escalate unsent. */
  maxInputBytes: number;
} & (
  | {
      runtime: "opencode";
      /** The reviewer session's model; the main session's when unset. */
      model?: ModelReference;
      /** Remove completed reviewer sessions only when explicitly enabled. */
      cleanupSessions: boolean;
    }
  | {
      runtime: SdkRuntime;
      /** A model name for Claude Code or Codex; the tool's own default when unset. */
      model?: string;
      /**
       * The installed SDK package directory, used instead of importing it from
       * where the plugin is installed.
       */
      sdkPath?: string;
    }
);

export type PluginConfiguration = {
  mode: ReviewerMode;
  /** V2 all-tools: preserve native asks unless explicitly opted into AI review. */
  allToolsNativeAsks: "preserve" | "review";
  auditLog: { enabled: boolean; includeCommand: boolean; path?: string };
  conversation: { enabled: boolean; includeAssistant: boolean };
  reviewer: {
    backend: ReviewerBackend;
    agent: AgentConfiguration;
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
 * Jev refuses a question over 32Ki tokens (the `state` plus that question; Jev
 * 1.14's 64Ki is per request, shared by all questions), so 28,000 leaves room
 * for the question and the estimate. Clef accepts 64Ki but took 46 s for 38k tokens,
 * past the default timeout, so its budget stays where it answered in seconds.
 */
const defaultMaxStateTokens: Record<DecisionProvider, number> = {
  typesafe: 28_000,
  cloudflare: 20_000,
};

/**
 * TypeSafe's long-context header raises Jev's limit to 262,144 tokens per
 * question and per request (Jev 1.13 and 1.14). 240,000 leaves the same kind of
 * room as the default budget; 241k measured tokens answered in 4.4 s.
 */
const defaultLongContextMaxStateTokens = 240_000;

const MAX_LONG_CONTEXT_STATE_TOKENS = 256_000;

/** A single dangerous line is easier to miss in a large operation. */
const defaultLongContextMinAllowProbability = 0.8;

/**
 * LLM reviewers have long contexts; this keeps one review to a bounded cost,
 * within what a hosted model reads whole, and leaves the agent reviewer room
 * to read files before its session would be compacted.
 */
const defaultMaxLLMInputBytes = 200_000;

const defaultChatBaseURL = "https://api.openai.com/v1";

/**
 * Custom instructions are sent with every review (and billed per call with the
 * decision backend), so by default they are kept to a short policy rather than
 * a document. `reviewer.maxInstructionsChars` raises the limit up to the
 * ceiling; each reviewer in use must still have room left for the operation
 * (see `assertInstructionsFit`).
 */
const defaultMaxInstructionsChars = 4_000;
const maxInstructionsCharsCeiling = 200_000;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const modelReferenceSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const sdkOptionsSchema = z.object({
  path: z.optional(z.string().check(z.refine(isAbsolute))),
});

const agentOptionsSchema = z.object({
  runtime: z.optional(z.enum(agentRuntimes)),
  // An OpenCode provider/model pair, or a Claude model name for the Claude
  // Agent SDK; which one is checked against the runtime.
  model: z.optional(z.union([modelReferenceSchema, z.string().check(z.minLength(1))])),
  maxInputBytes: z.optional(z.int().check(z.gte(1_000), z.lte(4_000_000))),
  cleanupSessions: z.optional(z.boolean()),
  claudeAgentSdk: z.optional(sdkOptionsSchema),
  codexSdk: z.optional(sdkOptionsSchema),
});

const decisionOptionsShape = {
  apiKey: z.optional(z.string()),
  model: z.optional(z.string().check(z.minLength(1))),
  minAllowProbability: z.optional(z.number().check(z.gte(0), z.lte(1))),
  maxStateTokens: z.optional(z.int().check(z.gte(1_000), z.lte(60_000))),
  onOversize: z.optional(z.enum(oversizeActions)),
};

const chatOptionsSchema = z.object({
  provider: z.optional(z.enum(chatProviders)),
  apiKey: z.optional(z.string()),
  baseURL: z.optional(z.string()),
  model: z.string().check(z.minLength(1)),
  maxInputBytes: z.optional(z.int().check(z.gte(1_000), z.lte(4_000_000))),
});

const longContextOptionsSchema = z.union([
  z.boolean(),
  z.object({
    maxStateTokens: z.optional(z.int().check(z.gte(1_000), z.lte(MAX_LONG_CONTEXT_STATE_TOKENS))),
    minAllowProbability: z.optional(z.number().check(z.gte(0), z.lte(1))),
  }),
]);

const typeSafeOptionsSchema = z.object({
  ...decisionOptionsShape,
  baseURL: z.optional(z.string()),
  longContext: z.optional(longContextOptionsSchema),
});

const decisionOptionsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("typesafe"), ...typeSafeOptionsSchema.shape }),
  z.object({
    provider: z.literal("cloudflare"),
    ...decisionOptionsShape,
    accountId: z.optional(z.string()),
    // Rejected with a clear message rather than silently ignored.
    longContext: z.optional(z.unknown()),
  }),
]);

const pluginConfigurationSchema = z.object({
  auditLog: z.optional(
    z.object({
      enabled: z.optional(z.boolean()),
      includeCommand: z.optional(z.boolean()),
      path: z.optional(z.string().check(z.refine(isAbsolute))),
    }),
  ),
  conversation: z.optional(
    z.object({
      enabled: z.optional(z.boolean()),
      includeAssistant: z.optional(z.boolean()),
    }),
  ),
  mode: z.optional(z.enum(reviewerModes)),
  allToolsNativeAsks: z.optional(z.enum(["preserve", "review"] as const)),
  reviewer: z.optional(
    z.object({
      backend: z.optional(z.enum(reviewerBackends)),
      agent: z.optional(agentOptionsSchema),
      /** Deprecated: `agent.model`. */
      model: z.optional(modelReferenceSchema),
      timeoutMs: z.optional(z.number().check(z.gte(1), z.lte(120_000))),
      instructions: z.optional(z.union([z.string(), z.array(z.string())])),
      maxInstructionsChars: z.optional(
        z.int().check(z.gte(defaultMaxInstructionsChars), z.lte(maxInstructionsCharsCeiling)),
      ),
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
  const instructions = reviewerInstructions({
    input: reviewer?.instructions,
    maxChars: reviewer?.maxInstructionsChars ?? defaultMaxInstructionsChars,
  });
  const env = input.env ?? process.env;
  const decision = backend === "decision" ? decisionConfiguration({ reviewer, env }) : undefined;
  const configuration: PluginConfiguration = {
    mode: result.data.mode ?? "on-ask",
    allToolsNativeAsks: result.data.allToolsNativeAsks ?? "preserve",
    auditLog: auditConfiguration(result.data.auditLog),
    conversation: conversationConfiguration(result.data.conversation),
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
  assertInstructionsFit(configuration);
  return configuration;
}

/**
 * Instructions go out with every review and count toward each reviewer's size
 * limit, so instructions that leave no room for the operation would make every
 * review too large. That fails at startup instead of escalating every call.
 */
function instructionsTooLarge({ size, limit }: { size: string; limit: string }): never {
  throw new Error(
    `Invalid auto-approval plugin options: reviewer.instructions (${size}) leave no room for the operation within ${limit}.`,
  );
}

function assertInstructionsFit(configuration: PluginConfiguration): void {
  const { instructions, backend, agent, chat, decision } = configuration.reviewer;
  if (instructions === undefined) return;
  const bytes = Buffer.byteLength(instructions, "utf8");
  if ((backend === "agent" || decision?.onOversize === "agent") && bytes >= agent.maxInputBytes) {
    instructionsTooLarge({
      size: `${bytes.toLocaleString("en-US")} bytes`,
      limit: `reviewer.agent.maxInputBytes (${agent.maxInputBytes.toLocaleString("en-US")})`,
    });
  }
  if (chat !== undefined && bytes >= chat.maxInputBytes) {
    instructionsTooLarge({
      size: `${bytes.toLocaleString("en-US")} bytes`,
      limit: `reviewer.chat.maxInputBytes (${chat.maxInputBytes.toLocaleString("en-US")})`,
    });
  }
  if (decision !== undefined) {
    const tokens = estimateTokens(instructions);
    const budget = decision.longContext?.maxStateTokens ?? decision.maxStateTokens;
    const name =
      decision.longContext === undefined ? "maxStateTokens" : "longContext.maxStateTokens";
    if (tokens >= budget) {
      instructionsTooLarge({
        size: `about ${tokens.toLocaleString("en-US")} tokens`,
        limit: `reviewer.decision.${name} (${budget.toLocaleString("en-US")})`,
      });
    }
  }
}

function conversationConfiguration(
  input: z.infer<typeof pluginConfigurationSchema>["conversation"],
): PluginConfiguration["conversation"] {
  return {
    enabled: input?.enabled ?? false,
    includeAssistant: input?.includeAssistant ?? false,
  };
}

function auditConfiguration(
  input: z.infer<typeof pluginConfigurationSchema>["auditLog"],
): PluginConfiguration["auditLog"] {
  const configuration = {
    enabled: input?.enabled ?? false,
    includeCommand: input?.includeCommand ?? false,
    path: input?.path,
  };
  if (configuration.enabled && !configuration.path) {
    throw new Error(
      "Invalid auto-approval plugin options: auditLog.path must be an absolute path when enabled.",
    );
  }
  return configuration;
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
 * Whether the read-only OpenCode reviewer agent is used: as the backend, or
 * for operations too large for the decision model. The SDK runtimes review
 * outside OpenCode and need no agent there.
 */
export function usesAgentReviewer(configuration: PluginConfiguration): boolean {
  return (
    configuration.reviewer.agent.runtime === "opencode" &&
    (configuration.reviewer.backend === "agent" ||
      configuration.reviewer.decision?.onOversize === "agent")
  );
}

/**
 * Joins the configured instructions into one block. An array is the readable
 * form in JSON, which cannot hold a multi-line string; blank entries are
 * dropped so a list can be commented out line by line.
 */
function reviewerInstructions({
  input,
  maxChars,
}: {
  input: string | string[] | undefined;
  maxChars: number;
}): string | undefined {
  const lines = (typeof input === "string" ? [input] : (input ?? []))
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return undefined;
  const text = lines.join("\n");
  if (text.length > maxChars) {
    const hint =
      maxChars < maxInstructionsCharsCeiling
        ? `; raise reviewer.maxInstructionsChars (up to ${maxInstructionsCharsCeiling}) to allow more`
        : "";
    throw new Error(
      `Invalid auto-approval plugin options: reviewer.instructions must be at most ${maxChars} characters${hint}.`,
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

/** `agent.model`, or the deprecated `reviewer.model`, checked against the runtime. */
function agentConfiguration(reviewer: ReviewerOptions | undefined): AgentConfiguration {
  const agent = reviewer?.agent ?? {};
  const model = agent.model ?? reviewer?.model;
  const maxInputBytes = agent.maxInputBytes ?? defaultMaxLLMInputBytes;
  const runtime = agent.runtime ?? "opencode";
  // Options for another runtime would be silently ignored.
  for (const [name, { option }] of Object.entries(sdkRuntimes)) {
    if (agent[option] !== undefined && runtime !== name) {
      throw new Error(
        `Invalid auto-approval plugin options: reviewer.agent.${option} needs reviewer.agent.runtime "${name}".`,
      );
    }
  }
  if (runtime !== "opencode") {
    if (agent.cleanupSessions !== undefined) {
      throw new Error('reviewer.agent.cleanupSessions requires reviewer.agent.runtime "opencode".');
    }
    return sdkAgentConfiguration({
      runtime,
      model,
      maxInputBytes,
      sdkPath: agent[sdkRuntimes[runtime].option]?.path,
    });
  }
  if (typeof model === "string") {
    throw new Error(
      'Invalid auto-approval plugin options: with the "opencode" runtime, reviewer.agent.model must be { providerID, modelID }.',
    );
  }
  return {
    runtime: "opencode",
    maxInputBytes,
    cleanupSessions: agent.cleanupSessions ?? false,
    ...(model === undefined ? {} : { model }),
  };
}

function sdkAgentConfiguration(input: {
  runtime: SdkRuntime;
  model: string | ModelReference | undefined;
  maxInputBytes: number;
  sdkPath: string | undefined;
}): AgentConfiguration {
  if (input.model !== undefined && typeof input.model !== "string") {
    throw new Error(
      `Invalid auto-approval plugin options: with the "${input.runtime}" runtime, reviewer.agent.model must be a model name such as "${sdkRuntimes[input.runtime].example}".`,
    );
  }
  return {
    runtime: input.runtime,
    maxInputBytes: input.maxInputBytes,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.sdkPath === undefined ? {} : { sdkPath: input.sdkPath }),
  };
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
  const minAllowProbability = input.options.minAllowProbability ?? defaultMinAllowProbability;
  const maxStateTokens = input.options.maxStateTokens ?? defaultMaxStateTokens.typesafe;
  const longContext = longContextConfiguration({
    options: input.options.longContext,
    minAllowProbability,
    maxStateTokens,
    prefix: input.prefix,
  });
  return {
    provider: "typesafe",
    apiKey,
    endpoint: typeSafeEndpoint(source.baseURL ?? defaultTypeSafeBaseURL),
    model: input.options.model ?? defaultModels.typesafe,
    minAllowProbability,
    maxStateTokens,
    ...(longContext === undefined ? {} : { longContext }),
    onOversize: input.options.onOversize ?? "escalate",
  };
}

/**
 * `true` or an object turns long context on; it is off by default because
 * TypeSafe documents long-context answers as slower and less accurate. For
 * the same reason its threshold is never below the regular one, and defaults
 * to at least `defaultLongContextMinAllowProbability`.
 */
function longContextConfiguration(input: {
  options: z.infer<typeof longContextOptionsSchema> | undefined;
  minAllowProbability: number;
  maxStateTokens: number;
  prefix: string;
}): LongContextConfiguration | undefined {
  if (input.options === undefined || input.options === false) return undefined;
  const options = input.options === true ? {} : input.options;
  const maxStateTokens = options.maxStateTokens ?? defaultLongContextMaxStateTokens;
  if (maxStateTokens <= input.maxStateTokens) {
    throw new Error(
      `Invalid auto-approval plugin options: ${input.prefix}.longContext.maxStateTokens must be larger than ${input.prefix}.maxStateTokens.`,
    );
  }
  const minAllowProbability =
    options.minAllowProbability ??
    Math.max(input.minAllowProbability, defaultLongContextMinAllowProbability);
  if (minAllowProbability < input.minAllowProbability) {
    throw new Error(
      `Invalid auto-approval plugin options: ${input.prefix}.longContext.minAllowProbability must not be below ${input.prefix}.minAllowProbability.`,
    );
  }
  return { maxStateTokens, minAllowProbability };
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
  if (input.options.longContext !== undefined && input.options.longContext !== false) {
    throw new Error(
      `Invalid auto-approval plugin options: ${input.prefix}.longContext is only available with the typesafe provider.`,
    );
  }
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
 * The vendor APIs: a fixed endpoint, so their key can only ever reach that
 * host, and the vendor's usual key variable.
 */
const vendorChatAPIs = {
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", keyVariable: "OPENAI_API_KEY" },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    keyVariable: "ANTHROPIC_API_KEY",
  },
} as const;

/**
 * `reviewer.chat`: an OpenAI-compatible Chat Completions API, or the OpenAI or
 * Anthropic API itself. As with TypeSafe, the key and the base URL of an
 * OpenAI-compatible endpoint come from the same place — the options, or
 * AUTO_APPROVAL_CHAT_API_KEY with AUTO_APPROVAL_CHAT_BASE_URL — so one source
 * cannot send a key supplied by another to its own server.
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
  const provider = options.provider ?? "openai-compatible";
  if (provider !== "openai-compatible") {
    return vendorChatConfiguration({ provider, options, env: input.env });
  }
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
    provider,
    apiKey: source.apiKey,
    endpoint: chatEndpoint(source.baseURL ?? defaultChatBaseURL),
    model: options.model,
    maxInputBytes: options.maxInputBytes ?? defaultMaxLLMInputBytes,
  };
}

function vendorChatConfiguration(input: {
  provider: Exclude<ChatProvider, "openai-compatible">;
  options: z.infer<typeof chatOptionsSchema>;
  env: Environment;
}): ChatConfiguration {
  const { endpoint, keyVariable } = vendorChatAPIs[input.provider];
  // Blank counts as unset, as for openai-compatible: `{env:NAME}` of an unset variable is "".
  if (nonEmpty(input.options.baseURL?.trim()) !== undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: reviewer.chat.baseURL is not used with the ${input.provider} provider; use provider "openai-compatible" for another endpoint.`,
    );
  }
  const apiKey = nonEmpty(input.options.apiKey?.trim()) ?? nonEmpty(input.env[keyVariable]?.trim());
  if (apiKey === undefined) {
    throw new Error(
      `Invalid auto-approval plugin options: the ${input.provider} provider needs reviewer.chat.apiKey or ${keyVariable}.`,
    );
  }
  return {
    provider: input.provider,
    apiKey,
    endpoint,
    model: input.options.model,
    maxInputBytes: input.options.maxInputBytes ?? defaultMaxLLMInputBytes,
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
