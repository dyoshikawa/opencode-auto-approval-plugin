import type { PluginConfiguration } from "./config.js";
import { isRecord, textFromParts } from "./shared.js";

export const HISTORY_TIMEOUT_MS = 1_000;
export const HISTORY_MESSAGE_LIMIT = 32;
export const MAX_CONVERSATION_TURNS = 8;
export const MAX_CONVERSATION_CHARACTERS = 12_000;

export type ConversationTurn = { role: "user" | "assistant"; text: string };
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

function humanTurn(input: {
  message: Record<string, unknown>;
  info: Record<string, unknown>;
  parts: unknown;
  generation: "v1" | "v2";
  includeAssistant: boolean;
}): ConversationTurn | undefined {
  if (excluded(input.info) || (isRecord(input.info.metadata) && excluded(input.info.metadata)))
    return undefined;
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

/** No cache: re-read the host and reconcile the live prompt before every review. */
export async function readConversation(input: {
  load(): Promise<ConversationContext>;
  latest(): string | undefined;
  configuration: PluginConfiguration["conversation"];
}): Promise<{ userIntent?: string; conversation: ConversationContext }> {
  let conversation: ConversationContext = { turns: [], incomplete: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (input.configuration.enabled) {
    try {
      conversation = await Promise.race([
        input.load(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Session history timed out.")),
            HISTORY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      conversation.incomplete = true;
    } finally {
      clearTimeout(timer);
    }
  }
  const latest = input.latest();
  if (
    latest !== undefined &&
    conversation.turns.findLast((turn) => turn.role === "user")?.text !== latest
  ) {
    conversation.turns.push({ role: "user", text: latest });
  }
  // Keep the latest intent even if it cannot fit as a whole conversation turn.
  const userIntent = latest ?? conversation.turns.findLast((turn) => turn.role === "user")?.text;
  const bounded = boundedConversation(conversation.turns);
  bounded.incomplete ||= conversation.incomplete;
  if (conversation.historyLimitReached) bounded.historyLimitReached = true;
  return { userIntent, conversation: bounded };
}
