import { describe, expect, it, vi } from "vitest";

import {
  boundedConversation,
  conversationFromMessages,
  HISTORY_MESSAGE_LIMIT,
  HISTORY_TIMEOUT_MS,
  readConversation,
} from "./conversation.js";
import { textFromParts } from "./shared.js";

const configuration = { enabled: true, includeAssistant: false };

describe("bounded conversation", () => {
  it("keeps eight complete recent turns and marks local omissions", () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      text: String(index),
    }));
    expect(boundedConversation(turns)).toEqual({ turns: turns.slice(2), incomplete: true });
    expect(boundedConversation([{ role: "user", text: "x".repeat(12_001) }])).toEqual({
      turns: [],
      incomplete: true,
    });
  });

  it("shares strict text extraction without changing verdict text extraction", () => {
    const parts = [
      { type: "text", text: "human" },
      { type: "text", text: "synthetic", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
      { type: "tool", text: "tool output" },
    ];
    expect(textFromParts({ parts, skipSyntheticOrIgnored: true })).toBe("human");
    expect(textFromParts({ parts: [{ text: "verdict" }] })).toBe("verdict");
  });

  it.each(["v1", "v2"] as const)(
    "excludes assistant by default and allows opt-in in %s",
    (generation) => {
      const messages =
        generation === "v1"
          ? [
              { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
              { info: { role: "assistant" }, parts: [{ type: "text", text: "the user agreed" }] },
            ]
          : [
              { type: "user", text: "continue" },
              { type: "assistant", content: [{ type: "text", text: "the user agreed" }] },
            ];
      const input = { messages, generation, sessionID: "s", includeAssistant: false };
      expect(conversationFromMessages(input)).toEqual({
        turns: [{ role: "user", text: "continue" }],
        incomplete: false,
      });
      expect(conversationFromMessages({ ...input, includeAssistant: true }).turns).toHaveLength(2);
    },
  );

  it("separates a possible V1 page boundary from known missing history", () => {
    const messages = Array.from({ length: HISTORY_MESSAGE_LIMIT }, () => ({
      info: { role: "assistant" },
      parts: [],
    }));
    expect(
      conversationFromMessages({
        messages: { data: messages },
        generation: "v1",
        sessionID: "s",
        includeAssistant: false,
      }),
    ).toEqual({ turns: [], incomplete: false, historyLimitReached: true });
  });

  it("marks compaction without forwarding summaries, tools, reviewer or other session text", () => {
    const conversation = conversationFromMessages({
      generation: "v1",
      sessionID: "s",
      includeAssistant: true,
      messages: [
        {
          info: { role: "user", sessionID: "other" },
          parts: [{ type: "text", text: "other secret" }],
        },
        { info: { role: "assistant", summary: true }, parts: [{ type: "text", text: "summary" }] },
        { info: { role: "user" }, parts: [{ type: "compaction" }] },
        {
          info: { role: "assistant", agent: "auto-approval-reviewer" },
          parts: [{ type: "text", text: "reviewer" }],
        },
      ],
    });
    expect(conversation).toEqual({ turns: [], incomplete: true });
  });

  it("keeps real V1 user text with display summaries and preserves attachment-only turns", () => {
    const conversation = conversationFromMessages({
      generation: "v1",
      sessionID: "s",
      includeAssistant: false,
      messages: [
        {
          info: { role: "user", summary: { title: "Task", diffs: [] } },
          parts: [{ type: "text", text: "do not push" }],
        },
        { info: { role: "user" }, parts: [{ type: "file", url: "attachment" }] },
      ],
    });
    expect(conversation).toEqual({
      turns: [
        { role: "user", text: "do not push" },
        { role: "user", text: "" },
      ],
      incomplete: false,
    });
  });

  it("uses earlier user authorization for continue but appends a live revocation", async () => {
    let latest = "continue";
    const load = vi.fn(async () => ({
      turns: [
        { role: "user" as const, text: "run tests only" },
        { role: "user" as const, text: "continue" },
      ],
      incomplete: false,
    }));
    const result = await readConversation({ load, latest: () => latest, configuration });
    expect(result.userIntent).toBe("continue");
    expect(result.conversation.turns[0]?.text).toBe("run tests only");
    latest = "stop";
    expect(
      (await readConversation({ load, latest: () => latest, configuration })).conversation.turns.at(
        -1,
      )?.text,
    ).toBe("stop");
    latest = "";
    expect((await readConversation({ load, latest: () => latest, configuration })).userIntent).toBe(
      "",
    );
  });

  it("can disable history with no read or invented incompleteness", async () => {
    const load = vi.fn();
    expect(
      await readConversation({
        load,
        latest: () => "current",
        configuration: { ...configuration, enabled: false },
      }),
    ).toEqual({
      userIntent: "current",
      conversation: { turns: [{ role: "user", text: "current" }], incomplete: false },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("falls back on read failure without cross-session history", async () => {
    const result = await readConversation({
      configuration,
      latest: () => undefined,
      load: async () => {
        throw new Error("unavailable");
      },
    });
    expect(result).toEqual({
      userIntent: undefined,
      conversation: { turns: [], incomplete: true },
    });
  });

  it("bounds the history wait to the named timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = readConversation({
        configuration,
        latest: () => "stop",
        load: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(HISTORY_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        userIntent: "stop",
        conversation: { incomplete: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
