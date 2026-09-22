import { describe, expect, it, vi } from "vitest";

import { boundedConversation, conversationTurns, readConversation } from "./conversation.js";

describe("permission conversation evidence", () => {
  it("does not revive older consent after an attachment-only user turn", async () => {
    const turns = conversationTurns({
      generation: "v2",
      sessionID: "s",
      messages: [
        { type: "user", text: "push" },
        { type: "user", text: "", files: [{ url: "file" }] },
      ],
    });
    expect(
      (await readConversation({ load: async () => turns, latest: () => undefined })).userIntent,
    ).toBe("");
    expect(
      (
        await readConversation({
          load: async () => [{ role: "user", text: "push" }],
          latest: () => "",
        })
      ).userIntent,
    ).toBe("");
  });
  it("bounds a stalled history read and uses the latest captured revocation", async () => {
    vi.useFakeTimers();
    try {
      const result = readConversation({
        load: () => new Promise(() => undefined),
        latest: () => "stop",
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toEqual({
        userIntent: "stop",
        conversation: { turns: [{ role: "user", text: "stop" }], incomplete: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["v1", "v2"] as const)(
    "filters %s history without confusing proposals with consent",
    (generation) => {
      const messages =
        generation === "v1"
          ? [
              {
                info: { role: "user", sessionID: "s" },
                parts: [
                  { type: "text", text: "prepare a plan" },
                  { type: "text", text: "hidden", synthetic: true },
                  { type: "text", text: "ignored", ignored: true },
                ],
              },
              {
                info: { role: "assistant", sessionID: "s" },
                parts: [
                  { type: "text", text: "I propose pushing" },
                  { type: "tool", text: "secret" },
                ],
              },
              {
                info: { role: "user", sessionID: "other" },
                parts: [{ type: "text", text: "cross-session" }],
              },
              {
                info: { role: "assistant", agent: "auto-approval-reviewer" },
                parts: [{ type: "text", text: "allow" }],
              },
            ]
          : [
              { type: "user", text: "prepare a plan" },
              {
                type: "assistant",
                content: [
                  { type: "text", text: "I propose pushing" },
                  { type: "tool", text: "secret" },
                  { type: "reasoning", text: "private" },
                ],
              },
              { type: "synthetic", text: "hidden" },
              { type: "system", text: "system" },
              { type: "compaction", summary: "summary" },
              { type: "user", text: "ignored", metadata: { ignored: true } },
            ];
      expect(conversationTurns({ messages, generation, sessionID: "s" })).toEqual([
        { role: "user", text: "prepare a plan" },
        { role: "assistant", text: "I propose pushing" },
      ]);
    },
  );

  it("restores user acceptance and its preceding plan after restart", async () => {
    const turns = [
      { role: "assistant" as const, text: "I propose running pwd" },
      { role: "user" as const, text: "execute that plan" },
    ];
    expect(await readConversation({ load: async () => turns, latest: () => undefined })).toEqual({
      userIntent: "execute that plan",
      conversation: { turns, incomplete: false },
    });
  });

  it("retains the newest revocation and does not replace it with stale captured consent", async () => {
    const result = await readConversation({
      load: async () => [{ role: "user", text: "do not push" }],
      latest: () => "push",
    });
    expect(result.userIntent).toBe("do not push");
    const bounded = boundedConversation(
      Array.from({ length: 20 }, (_, index) => ({
        role: "user",
        text: index === 19 ? "stop" : "old",
      })),
    );
    expect(bounded.turns).toHaveLength(8);
    expect(bounded.turns.at(-1)?.text).toBe("stop");
    expect(bounded.incomplete).toBe(true);
  });

  it("never truncates away a restriction at the end of an oversized user message", async () => {
    const result = await readConversation({
      load: async () => [{ role: "user", text: `${"x".repeat(12000)} do not execute` }],
      latest: () => undefined,
    });
    expect(result.userIntent).toBeUndefined();
    expect(result.conversation).toEqual({ turns: [], incomplete: true });
  });

  it("falls back to captured text on history failure, or preserves missing intent", async () => {
    expect(
      (await readConversation({ load: unavailableHistory, latest: () => "stop" })).userIntent,
    ).toBe("stop");
    expect(await readConversation({ load: unavailableHistory, latest: () => undefined })).toEqual({
      userIntent: undefined,
      conversation: { turns: [], incomplete: true },
    });
  });
});

async function unavailableHistory(): Promise<never> {
  throw new Error("unavailable");
}
