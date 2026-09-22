import { isRecord } from "./shared.js";

export type ConversationTurn = { role: "user" | "assistant"; text: string };
export type ConversationContext = {
  turns: ConversationTurn[];
  incomplete: boolean;
};

const MAX_TURNS = 8;
const MAX_CHARACTERS = 12000;

/** Keep complete recent turns: truncating a user message can remove its revocation. */
export function boundedConversation(turns: ConversationTurn[]): ConversationContext {
  const selected: ConversationTurn[] = [];
  let characters = 0;
  for (const turn of turns.toReversed()) {
    if (selected.length === MAX_TURNS || characters + turn.text.length > MAX_CHARACTERS) break;
    selected.unshift(turn);
    characters += turn.text.length;
  }
  return { turns: selected, incomplete: selected.length !== turns.length };
}

/** Read only human text and assistant prose, never tools, synthetic input or control messages. */
export function conversationTurns(input: {
  messages: unknown;
  generation: "v1" | "v2";
  sessionID: string;
}): ConversationTurn[] {
  const messages =
    isRecord(input.messages) && "data" in input.messages ? input.messages.data : input.messages;
  if (!Array.isArray(messages)) throw new Error("Session history did not return messages.");
  return messages.flatMap((message): ConversationTurn[] => {
    if (!isRecord(message)) return [];
    const info = input.generation === "v1" ? message.info : message;
    if (!isRecord(info) || excluded(info)) return [];
    if (info.sessionID !== undefined && info.sessionID !== input.sessionID) return [];
    if (info.agent === "auto-approval-reviewer") return [];
    const role = input.generation === "v1" ? info.role : info.type;
    if (role !== "user" && role !== "assistant") return [];
    if (isRecord(info.metadata) && excluded(info.metadata)) return [];
    const parts = input.generation === "v1" ? message.parts : message.content;
    const text =
      input.generation === "v2" && role === "user"
        ? typeof message.text === "string"
          ? message.text
          : ""
        : Array.isArray(parts)
          ? humanText(parts)
          : "";
    // An attachment-only user turn must not revive an older textual authorization.
    return text.trim() || role === "user" ? [{ role, text }] : [];
  });
}

export function humanText(parts: unknown[]): string {
  return parts
    .flatMap((part) =>
      isRecord(part) &&
      part.type === "text" &&
      !part.synthetic &&
      !part.ignored &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function excluded(value: Record<string, unknown>): boolean {
  return Boolean(value.synthetic || value.ignored || value.summary);
}

/** A failed/slow host read falls back only to the current session's captured user text. */
export async function readConversation(input: {
  load(): Promise<ConversationTurn[]>;
  latest(): string | undefined;
  historyMayBeIncomplete?: boolean;
}): Promise<{ userIntent?: string; conversation: ConversationContext }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capturedBeforeRead = input.latest();
  let turns: ConversationTurn[];
  let failed = false;
  try {
    turns = await Promise.race([
      input.load(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session history timed out.")), 1000);
      }),
    ]);
  } catch {
    turns = [];
    failed = true;
  } finally {
    clearTimeout(timer);
  }
  const latest = input.latest();
  if (
    latest !== undefined &&
    (failed || turns.length === 0 || latest !== capturedBeforeRead || !latest.trim())
  ) {
    turns.push({ role: "user", text: latest });
  }
  const conversation = boundedConversation(turns);
  conversation.incomplete ||= failed || input.historyMayBeIncomplete === true;
  const userIntent = conversation.turns.findLast((turn) => turn.role === "user")?.text;
  return { userIntent, conversation };
}
