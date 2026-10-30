import type { PluginConfiguration } from "./config.js";
import { isRecord, textFromParts, withTimeout } from "./shared.js";

export const HISTORY_TIMEOUT_MS = 1_000;
export const HISTORY_MESSAGE_LIMIT = 32;
export const MAX_CONVERSATION_TURNS = 8;
const MAX_CONVERSATION_CHARACTERS = 12_000;

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  /** User answer extracted from a completed assistant question tool result. */
  source?: "question-answer";
};
export type ConversationContext = {
  turns: ConversationTurn[];
  /** Evidence of omission, not a guarantee of completeness when false. */
  incomplete: boolean;
  /** V1 returned a full page; more history may exist, but is not known to exist. */
  historyLimitReached?: boolean;
};

/** Keep whole recent turns: a text preview could hide a revocation. */
export function boundedConversation(turns: ConversationTurn[]): ConversationContext {
  const selected: ConversationTurn[] = [];
  let characters = 0;
  for (const turn of turns.toReversed()) {
    if (
      selected.length === MAX_CONVERSATION_TURNS ||
      characters + turn.text.length > MAX_CONVERSATION_CHARACTERS
    )
      break;
    selected.unshift(turn);
    characters += turn.text.length;
  }
  return { turns: selected, incomplete: selected.length !== turns.length };
}

export function conversationFromMessages(input: {
  messages: unknown;
  generation: "v1" | "v2";
  sessionID: string;
  includeAssistant: boolean;
}): ConversationContext {
  const messages =
    isRecord(input.messages) && "data" in input.messages ? input.messages.data : input.messages;
  if (!Array.isArray(messages)) throw new Error("Session history did not return messages.");
  // A full V1 page is evidence of a possible page boundary, not proof of truncation.
  const historyLimitReached = input.generation === "v1" && messages.length >= HISTORY_MESSAGE_LIMIT;
  let incomplete = false;
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const info = input.generation === "v1" ? message.info : message;
    if (!isRecord(info) || (info.sessionID !== undefined && info.sessionID !== input.sessionID))
      continue;
    const parts = input.generation === "v1" ? message.parts : message.content;
    if (hasCompaction({ info, parts })) {
      incomplete = true;
      continue;
    }
    const turn = humanTurn({
      message,
      info,
      parts,
      generation: input.generation,
      includeAssistant: input.includeAssistant,
    });
    if (turn) turns.push(turn);
    const answerContext = questionTurns({ generation: input.generation, info, parts });
    turns.push(...answerContext.turns);
    incomplete ||= answerContext.incomplete;
  }
  const conversation = boundedConversation(turns);
  conversation.incomplete ||= incomplete;
  if (historyLimitReached) conversation.historyLimitReached = true;
  return conversation;
}

function hasCompaction(input: { info: Record<string, unknown>; parts: unknown }): boolean {
  return Boolean(
    input.info.summary === true ||
    input.info.type === "compaction" ||
    (isRecord(input.info.metadata) && input.info.metadata.summary === true) ||
    (Array.isArray(input.parts) &&
      input.parts.some((part) => isRecord(part) && part.type === "compaction")),
  );
}

function excluded(info: Record<string, unknown>): boolean {
  return Boolean(
    info.synthetic ||
    info.ignored ||
    info.summary === true ||
    info.agent === "auto-approval-reviewer",
  );
}

function excludedMessage(info: Record<string, unknown>): boolean {
  return excluded(info) || (isRecord(info.metadata) && excluded(info.metadata));
}

function humanTurn(input: {
  message: Record<string, unknown>;
  info: Record<string, unknown>;
  parts: unknown;
  generation: "v1" | "v2";
  includeAssistant: boolean;
}): ConversationTurn | undefined {
  if (excludedMessage(input.info)) return undefined;
  const role = input.generation === "v1" ? input.info.role : input.info.type;
  if (role !== "user" && !(role === "assistant" && input.includeAssistant)) return undefined;
  const text =
    input.generation === "v2" && role === "user"
      ? typeof input.message.text === "string"
        ? input.message.text
        : ""
      : Array.isArray(input.parts)
        ? textFromParts({ parts: input.parts, skipSyntheticOrIgnored: true })
        : "";
  return text.trim() || role === "user" ? { role, text } : undefined;
}

/**
 * OpenCode's question tool stores answers in state.metadata.answers.
 * Confirmed against the official question tool, question schema and client
 * SessionMessageAssistantTool type (OpenCode upstream).
 */
const MAX_QUESTION_TURN_CHARS = 2_500;
const MAX_QUESTION_TEXT_CHARS = 500;
const MAX_ANSWER_TEXT_CHARS = 1_000;
const MAX_QUESTIONS = 8;
const MAX_SELECTED_ANSWERS = 12;

function questionTurns(input: {
  generation: "v1" | "v2";
  info: Record<string, unknown>;
  parts: unknown;
}): ConversationContext {
  if (input.generation !== "v2" || input.info.type !== "assistant" || excludedMessage(input.info))
    return { turns: [], incomplete: false };
  const answers = questionAnswers(input.parts);
  return {
    turns: answers.turns.map((text) => ({
      role: "user" as const,
      text,
      source: "question-answer" as const,
    })),
    incomplete: answers.incomplete,
  };
}

type QuestionPair = {
  assistantAuthoredQuestion: string;
  /** Selected labels are written by the agent; the user only clicked them. */
  selectedAssistantOptionLabels: string[];
  /** Values not matching any offered option are custom responses. */
  typedCustomAnswers: string[];
  /** Fallback for incomplete question inputs lacking option definitions. */
  unclassifiedAnswerValues?: string[];
};

function questionPair(question: unknown, answer: unknown): QuestionPair | undefined {
  if (
    !isRecord(question) ||
    typeof question.question !== "string" ||
    !question.question.trim() ||
    question.question.length > MAX_QUESTION_TEXT_CHARS ||
    !Array.isArray(answer) ||
    answer.length === 0 ||
    answer.length > MAX_SELECTED_ANSWERS ||
    answer.some(
      (value) => typeof value !== "string" || !value.trim() || value.length > MAX_ANSWER_TEXT_CHARS,
    )
  )
    return undefined;
  const values = answer.map((value: string) => value.trim());
  if (!Array.isArray(question.options)) {
    return {
      assistantAuthoredQuestion: question.question,
      selectedAssistantOptionLabels: [],
      typedCustomAnswers: [],
      unclassifiedAnswerValues: values,
    };
  }
  const labels = question.options
    .filter((option) => isRecord(option) && typeof option.label === "string")
    .map((option: Record<string, unknown>) => option.label as string);
  return {
    assistantAuthoredQuestion: question.question,
    selectedAssistantOptionLabels: values.filter((value: string) => labels.includes(value)),
    typedCustomAnswers: values.filter((value: string) => !labels.includes(value)),
  };
}

/** A completed result is evidence of a user response, not an automatic grant.
 * Keep the model-authored question explicitly separate from the actual answer,
 * JSON-encode values to prevent quote injection and skip oversized results.
 */
function questionAnswers(parts: unknown): { turns: string[]; incomplete: boolean } {
  if (!Array.isArray(parts)) return { turns: [], incomplete: false };
  const turns: string[] = [];
  let incomplete = false;
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "tool" || part.name !== "question") continue;
    const state = part.state;
    if (!isRecord(state) || state.status !== "completed") continue;
    const questions = isRecord(state.input) ? state.input.questions : undefined;
    const answers = isRecord(state.metadata) ? state.metadata.answers : undefined;
    if (
      !Array.isArray(questions) ||
      !Array.isArray(answers) ||
      questions.length === 0 ||
      questions.length > MAX_QUESTIONS ||
      questions.length !== answers.length
    ) {
      incomplete = true;
      continue;
    }
    const pairs: QuestionPair[] = [];
    let valid = true;
    for (let i = 0; i < questions.length; i++) {
      const pair = questionPair(questions[i], answers[i]);
      if (!pair) {
        valid = false;
        break;
      }
      pairs.push(pair);
    }
    if (!valid) {
      incomplete = true;
      continue;
    }
    const text =
      "Completed OpenCode question interaction. The assistant authored each question and option label; clicking an option is NOT the user writing its label. Only typedCustomAnswers are user-written text. Selections are scoped to their paired question, never blanket permission: " +
      JSON.stringify(pairs);
    if (text.length > MAX_QUESTION_TURN_CHARS) {
      incomplete = true;
      continue;
    }
    turns.push(text);
  }
  return { turns, incomplete };
}

/** No cache: re-read the host and reconcile the live prompt before every review. */
export async function readConversation(input: {
  load(): Promise<ConversationContext>;
  latest(): string | undefined;
  configuration: PluginConfiguration["conversation"];
}): Promise<{ userIntent?: string; conversation?: ConversationContext }> {
  // Disabled, the reviewer sees the captured prompt only, as before the option existed.
  if (!input.configuration.enabled) {
    const latest = input.latest();
    return latest === undefined ? {} : { userIntent: latest };
  }
  let conversation: ConversationContext = { turns: [], incomplete: false };
  try {
    conversation = await withTimeout({
      promise: input.load(),
      ms: HISTORY_TIMEOUT_MS,
      message: "Session history timed out.",
    });
  } catch {
    conversation.incomplete = true;
  }
  const latest = input.latest();
  // Compare only with the last ordinary user turn. Repeated "stop" and
  // "continue" are distinct new prompts when intervening turns exist.
  const lastOrdinaryIndex = conversation.turns.findLastIndex(
    (turn) => turn.role === "user" && turn.source !== "question-answer",
  );
  const latestInHistory =
    latest !== undefined && conversation.turns[lastOrdinaryIndex]?.text === latest;
  if (latest !== undefined && !latestInHistory) {
    conversation.turns.push({ role: "user", text: latest });
  }
  // userIntent is always the latest ordinary human prompt, never a question
  // created by the model or the model-authored labels the user selected.
  const userIntent =
    latest ??
    conversation.turns.findLast(
      (turn) => turn.role === "user" && turn.source !== "question-answer",
    )?.text;
  const bounded = boundedConversation(conversation.turns);
  bounded.incomplete ||= conversation.incomplete;
  if (conversation.historyLimitReached) bounded.historyLimitReached = true;
  return { userIntent, conversation: bounded };
}
