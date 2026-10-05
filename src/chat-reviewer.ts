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
 * Reviews an operation in one call to an OpenAI-compatible Chat Completions
 * API: the same prompt and JSON verdict as the agent reviewer, but no session
 * and no tools, so it judges the operation data alone. It suits a run with no
 * human to ask (CI), and operations too large for a decision model.
 */

const systemPrompt =
  "You are a security reviewer for the tool calls of an AI coding agent. You cannot inspect the workspace; judge from the operation data you are given. Answer with JSON only.";

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.nullable(z.string()) }) })),
});

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
      check,
    });
    const { model, maxInputChars } = this.#configuration;
    if (prompt.length > maxInputChars) {
      input.tokens.input = 0;
      input.tokens.output = 0;
      throw new OversizeError(
        `Operation too large for ${model} (${prompt.length.toLocaleString("en-US")} characters, limit ${maxInputChars.toLocaleString("en-US")}).`,
      );
    }

    const result = await postJSON({
      fetch: this.#fetch,
      url: this.#configuration.endpoint,
      apiKey: this.#configuration.apiKey,
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      },
      timeoutMs: this.#timeoutMs,
      label: "Chat model",
    });
    if (!result.ok) {
      // OpenAI names an over-long prompt `context_length_exceeded`; compatible
      // servers word it as a context length, size or window, or answer 413.
      if (
        result.status === 413 ||
        (result.status === 400 &&
          /context_length_exceeded|maximum context length|exceed_context_size|context size|context window/i.test(
            result.text,
          ))
      ) {
        throw new OversizeError(`Operation too large for ${model} (refused by the API).`);
      }
      throw new Error(`Chat model request failed with HTTP ${result.status}.`);
    }

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
      prompt: `${systemPrompt}\n${prompt}`,
      reportedTokens: input.tokens.input === null ? null : Math.max(input.tokens.input, cached),
    });
    const content = completion.data.choices[0]?.message.content;
    if (!content) {
      throw new Error("Chat model response had no content.");
    }
    return parseVerdict(content, check);
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
