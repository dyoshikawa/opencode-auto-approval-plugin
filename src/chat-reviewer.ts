import * as z from "zod/mini";

import type { ChatConfiguration, PluginConfiguration } from "./config.js";
import { type Fetch, postJSON } from "./http.js";
import {
  assertReadWhole,
  OversizeError,
  parseVerdict,
  type Reviewer,
  type ReviewRequest,
  type ReviewVerdict,
  reviewCheck,
  reviewerPrompt,
} from "./reviewer.js";
import type { UsageRecorder } from "./usage.js";

/**
 * Reviews an operation in one call to a Chat Completions API (OpenAI or a
 * compatible server) or Anthropic's Messages API: the same prompt and JSON verdict as the agent reviewer, but no session
 * and no tools, so it judges the operation data alone. It suits a run with no
 * human to ask (CI), and operations too large for a decision model.
 */

const systemPrompt =
  "You are a security reviewer for the tool calls of an AI coding agent. You cannot inspect the workspace; judge from the operation data you are given. Answer with JSON only.";

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.nullable(z.string()) }) })),
});

/** The Messages API response; usage is read leniently, as for Chat Completions. */
const messageSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.optional(z.string()) })),
  stop_reason: z.optional(z.nullable(z.string())),
  usage: z.optional(
    z.object({
      input_tokens: z.optional(z.nullable(z.number())),
      output_tokens: z.optional(z.nullable(z.number())),
      cache_creation_input_tokens: z.optional(z.nullable(z.number())),
      cache_read_input_tokens: z.optional(z.nullable(z.number())),
    }),
  ),
});

const anthropicVersion = "2023-06-01";

/**
 * Room for the verdict and, on models that always think, the thinking that
 * precedes it; a non-streaming request this size stays within SDK timeouts.
 */
const anthropicMaxTokens = 16_000;

type Tokens = { input: number | null; output: number | null };

/** Read on its own and leniently: token counts must never decide a review. */
const usageSchema = z.object({
  usage: z.object({
    prompt_tokens: z.optional(z.nullable(z.number())),
    completion_tokens: z.optional(z.nullable(z.number())),
    prompt_tokens_details: z.optional(
      z.nullable(z.object({ cached_tokens: z.optional(z.nullable(z.number())) })),
    ),
  }),
});

export class ChatReviewer implements Reviewer {
  readonly #configuration: ChatConfiguration;
  readonly #timeoutMs: number;
  readonly #instructions: string | undefined;
  readonly #replaceDefaultPolicy: boolean;
  readonly #fetch: Fetch;
  readonly #recordUsage: UsageRecorder | undefined;
  readonly #project: string;

  constructor(input: {
    configuration: PluginConfiguration;
    fetch?: Fetch;
    recordUsage?: UsageRecorder;
    project?: string;
  }) {
    const chat = input.configuration.reviewer.chat;
    if (chat === undefined) {
      throw new Error("The chat reviewer is not configured.");
    }
    this.#configuration = chat;
    this.#timeoutMs = input.configuration.reviewer.timeoutMs;
    this.#instructions = input.configuration.reviewer.instructions;
    this.#replaceDefaultPolicy = input.configuration.reviewer.replaceDefaultPolicy === true;
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#recordUsage = input.recordUsage;
    this.#project = input.project ?? "";
  }

  isReviewerSession(): boolean {
    return false;
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    const startedAt = Date.now();
    const tokens = { input: null as number | null, output: null as number | null };
    try {
      const decision = await this.#review({ request: input, tokens });
      this.#record({ startedAt, tokens, verdict: decision.verdict });
      return decision;
    } catch (error) {
      this.#record({
        startedAt,
        tokens,
        verdict: error instanceof OversizeError ? "oversize" : "error",
      });
      throw error;
    }
  }

  async #review(input: {
    request: ReviewRequest;
    tokens: { input: number | null; output: number | null };
  }): Promise<ReviewVerdict> {
    const check = reviewCheck();
    const prompt = reviewerPrompt({
      request: input.request,
      instructions: this.#instructions,
      replaceDefaultPolicy: this.#replaceDefaultPolicy,
      check,
    });
    const { model, maxInputBytes } = this.#configuration;
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > maxInputBytes) {
      input.tokens.input = 0;
      input.tokens.output = 0;
      throw new OversizeError(
        `Operation too large for ${model} (${bytes.toLocaleString("en-US")} bytes, limit ${maxInputBytes.toLocaleString("en-US")}).`,
      );
    }

    const content =
      this.#configuration.provider === "anthropic"
        ? await this.#messages({ prompt, tokens: input.tokens })
        : await this.#chatCompletions({ prompt, tokens: input.tokens });
    return parseVerdict(content, check);
  }

  /** One Chat Completions call (OpenAI or a compatible server); resolves with the reply text. */
  async #chatCompletions(input: { prompt: string; tokens: Tokens }): Promise<string> {
    const { model } = this.#configuration;
    const result = await postJSON({
      fetch: this.#fetch,
      url: this.#configuration.endpoint,
      apiKey: this.#configuration.apiKey,
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.prompt },
        ],
      },
      timeoutMs: this.#timeoutMs,
      label: "Chat model",
    });
    if (!result.ok) throw this.#requestError(result);

    const completion = z.safeParse(completionSchema, result.body);
    if (!completion.success) {
      throw new Error("Chat model response did not match the completion schema.");
    }
    const usage = z.safeParse(usageSchema, result.body);
    const counts = usage.success ? usage.data.usage : undefined;
    input.tokens.input = tokenCount(counts?.prompt_tokens);
    input.tokens.output = tokenCount(counts?.completion_tokens);
    // `prompt_tokens` includes cached tokens on OpenAI; a server that left
    // them out still read them.
    const cached = tokenCount(counts?.prompt_tokens_details?.cached_tokens) ?? 0;
    assertReadWhole({
      model,
      prompt: `${systemPrompt}\n${input.prompt}`,
      reportedTokens: input.tokens.input === null ? null : Math.max(input.tokens.input, cached),
    });
    const content = completion.data.choices[0]?.message.content;
    if (!content) {
      throw new Error("Chat model response had no content.");
    }
    return content;
  }

  /** One call to Anthropic's Messages API; resolves with the reply text. */
  async #messages(input: { prompt: string; tokens: Tokens }): Promise<string> {
    const { model } = this.#configuration;
    const result = await postJSON({
      fetch: this.#fetch,
      url: this.#configuration.endpoint,
      apiKey: this.#configuration.apiKey,
      auth: "x-api-key",
      headers: { "anthropic-version": anthropicVersion },
      body: {
        model,
        max_tokens: anthropicMaxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: input.prompt }],
      },
      timeoutMs: this.#timeoutMs,
      label: "Chat model",
    });
    if (!result.ok) throw this.#requestError(result);

    const message = z.safeParse(messageSchema, result.body);
    if (!message.success) {
      throw new Error("Chat model response did not match the Messages API schema.");
    }
    const usage = message.data.usage;
    const cacheTokens =
      (tokenCount(usage?.cache_creation_input_tokens) ?? 0) +
      (tokenCount(usage?.cache_read_input_tokens) ?? 0);
    const inputTokens = tokenCount(usage?.input_tokens);
    // `input_tokens` leaves out the cached part of the prompt, which was read too.
    input.tokens.input = inputTokens === null ? null : inputTokens + cacheTokens;
    input.tokens.output = tokenCount(usage?.output_tokens);
    assertReadWhole({
      model,
      prompt: `${systemPrompt}\n${input.prompt}`,
      reportedTokens: input.tokens.input,
    });
    // Only a finished reply holds a verdict: a refusal carries none, and a
    // reply cut short — or stopped for a reason added later — cannot be trusted.
    const stopReason = message.data.stop_reason;
    if (stopReason === "model_context_window_exceeded") {
      throw new OversizeError(`Operation too large for ${model} (out of context window).`);
    }
    if (stopReason !== "end_turn" && stopReason !== "stop_sequence") {
      throw new Error(`Chat model reply stopped early (${String(stopReason)}).`);
    }
    const content = message.data.content
      .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
      .join("\n");
    if (!content) {
      throw new Error("Chat model response had no content.");
    }
    return content;
  }

  /** An over-long prompt is too large; any other refusal is reported by status only. */
  #requestError(result: { status: number; text: string }): Error {
    // OpenAI names an over-long prompt `context_length_exceeded`, Anthropic
    // "prompt is too long"; compatible servers word it as a context length,
    // size or window, or answer 413.
    if (
      result.status === 413 ||
      (result.status === 400 &&
        /context_length_exceeded|maximum context length|exceed_context_size|context size|context window|prompt is too long/i.test(
          result.text,
        ))
    ) {
      return new OversizeError(
        `Operation too large for ${this.#configuration.model} (refused by the API).`,
      );
    }
    return new Error(`Chat model request failed with HTTP ${result.status}.`);
  }

  #record(input: {
    startedAt: number;
    tokens: { input: number | null; output: number | null };
    verdict: ReviewVerdict["verdict"] | "error" | "oversize";
  }): void {
    if (this.#recordUsage === undefined) return;
    try {
      this.#recordUsage({
        v: 1,
        time: new Date(input.startedAt).toISOString(),
        provider: "chat",
        model: this.#configuration.model,
        project: this.#project,
        inputTokens: input.tokens.input,
        outputTokens: input.tokens.output,
        latencyMs: Math.max(0, Date.now() - input.startedAt),
        verdict: input.verdict,
        // Chat models are priced per provider and model; none is assumed.
        costUSD: input.tokens.input === 0 ? 0 : null,
      });
    } catch {
      // The usage log must never decide a review.
    }
  }
}

function tokenCount(input: number | null | undefined): number | null {
  return typeof input === "number" && Number.isInteger(input) && input >= 0 ? input : null;
}
