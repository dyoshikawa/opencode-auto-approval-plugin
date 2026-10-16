import { describe, expect, it, vi } from "vitest";

import { createV2Plugin, createV2SessionClient } from "./v2.js";

type ReviewerVerdict = "allow" | "deny" | "escalate";

type Hook = (event: Record<string, unknown>) => Promise<void> | void;

function createContext(input: { options?: Record<string, unknown> } = {}) {
  const hooks: Record<string, Hook> = {};
  const registration = { dispose: async () => undefined };
  const agents = new Map<string, Record<string, unknown>>();
  const session = {
    create: vi.fn(async () => ({ id: "review-session" })),
    prompt: vi.fn(async () => ({ id: "inbox-1" })),
    wait: vi.fn(async () => undefined),
    context: vi.fn(async (): Promise<Record<string, unknown>[]> => [
      { type: "user", text: "hello" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: '{"verdict":"allow","reason":"safe"}' },
        ],
      },
    ]),
    interrupt: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ id: "session-1", model: { providerID: "openai", id: "gpt-5.6" } })),
    hook: vi.fn(async (name: string, callback: Hook) => {
      hooks[`session.${name}`] = callback;
      return registration;
    }),
  };
  const context = {
    options: input.options ?? {},
    location: { directory: "/workspace" },
    session,
    agent: {
      transform: vi.fn(async (callback: (editor: unknown) => void) => {
        callback({
          update: (id: string, fn: (agent: Record<string, unknown>) => void) => {
            const agent = agents.get(id) ?? { id, permissions: [] };
            agents.set(id, agent);
            fn(agent);
          },
        });
        return registration;
      }),
    },
    permission: {
      hook: vi.fn(async (name: string, callback: Hook) => {
        hooks[`permission.${name}`] = callback;
        return registration;
      }),
    },
    tool: {
      hook: vi.fn(async (name: string, callback: Hook) => {
        hooks[`tool.${name}`] = callback;
        return registration;
      }),
    },
  };
  return { context, hooks, agents, session };
}

function createPlugin(input: { verdict: ReviewerVerdict }) {
  const review = vi.fn(async () => ({ verdict: input.verdict, reason: "reviewed" }));
  const isReviewerSession = vi.fn(
    (session: { sessionID: string }) => session.sessionID === "review-session",
  );
  const plugin = createV2Plugin({
    createReviewer: () => ({ review, isReviewerSession }) as never,
  });
  return { plugin, review, isReviewerSession };
}

function askEvent(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "session-1",
    action: "bash",
    resources: ["git push"],
    metadata: {},
    effect: "ask",
    ...overrides,
  };
}

describe("V2 plugin (opencode 2.x)", () => {
  it.each(["on-ask", "all-tools"])(
    "cancels stale %s approval even if the new prompt text repeats",
    async (mode) => {
      const { context, hooks, session } = createContext({
        options: { mode, conversation: { enabled: false } },
      });
      const { plugin, review } = createPlugin({ verdict: "allow" });
      await plugin.setup(context as never);
      await hooks["session.prompt"]?.({ sessionID: "session-1", prompt: { text: "continue" } });
      review.mockImplementationOnce(async () => {
        await hooks["session.prompt"]?.({ sessionID: "session-1", prompt: { text: "continue" } });
        return { verdict: "allow", reason: "stale" };
      });
      if (mode === "on-ask") {
        const event = askEvent();
        await hooks["permission.evaluate"]?.(event);
        expect(event.effect).toBe("ask");
      } else {
        await expect(
          hooks["tool.execute.before"]?.({ sessionID: "session-1", tool: "bash", input: {} }),
        ).rejects.toThrow("User intent changed");
      }
      expect(session.context).not.toHaveBeenCalled();
    },
  );

  it("includes assistant text only with explicit opt-in and does not use synthetic prompts", async () => {
    const { context, hooks } = createContext({
      options: { conversation: { enabled: true, includeAssistant: true } },
    });
    const { plugin, review } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);
    await hooks["session.prompt"]?.({
      sessionID: "session-1",
      prompt: { text: "injected" },
      metadata: { synthetic: true },
    });
    await hooks["permission.evaluate"]?.(askEvent());
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "hello",
        conversation: {
          turns: [
            { role: "user", text: "hello" },
            { role: "assistant", text: '{"verdict":"allow","reason":"safe"}' },
          ],
          incomplete: false,
        },
      }),
    );
  });

  it("registers a hidden read-only reviewer subagent", async () => {
    const { context, agents } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });

    await plugin.setup(context as never);

    expect(agents.get("auto-approval-reviewer")).toMatchObject({
      mode: "subagent",
      hidden: true,
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "allow" },
      ],
    });
  });

  it("registers no subagent for the decision backend", async () => {
    const { context, agents } = createContext({
      options: {
        reviewer: {
          backend: "decision",
          decision: { provider: "typesafe", apiKey: "test-key" },
        },
      },
    });
    const { plugin } = createPlugin({ verdict: "allow" });

    await plugin.setup(context as never);

    expect(context.agent.transform).not.toHaveBeenCalled();
    expect(agents.size).toBe(0);
  });

  it("registers the reviewer subagent for the decision backend's agent fallback", async () => {
    const { context, agents, hooks } = createContext({
      options: {
        reviewer: {
          backend: "decision",
          decision: { provider: "typesafe", apiKey: "test-key", onOversize: "agent" },
        },
      },
    });
    const { plugin, review } = createPlugin({ verdict: "allow" });

    await plugin.setup(context as never);
    await hooks["permission.evaluate"]?.(
      askEvent({ sessionID: "session-1", agent: "auto-approval-reviewer" }),
    );

    expect(agents.get("auto-approval-reviewer")).toMatchObject({ mode: "subagent", hidden: true });
    // Its own tool calls are the plugin's reviewer, not something to review.
    expect(review).not.toHaveBeenCalled();
  });

  it("looks up the session's model for the agent fallback", async () => {
    const { context, hooks } = createContext({
      options: {
        reviewer: {
          backend: "decision",
          decision: { provider: "typesafe", apiKey: "test-key", onOversize: "agent" },
        },
      },
    });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    await hooks["permission.evaluate"]?.(askEvent());

    expect(context.session.get).toHaveBeenCalled();
  });

  it("turns an ask into allow only when the reviewer allows it", async () => {
    const { context, hooks } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);
    await hooks["session.prompt"]?.({ sessionID: "session-1", prompt: { text: "push my branch" } });

    const event = askEvent();
    await hooks["permission.evaluate"]?.(event);

    expect(review).toHaveBeenCalledWith({
      source: "permission-request",
      sessionID: "session-1",
      action: "bash",
      resource: { resources: ["git push"], metadata: {} },
      userIntent: "push my branch",
      model: { providerID: "openai", modelID: "gpt-5.6" },
    });
    expect(event).toMatchObject({ effect: "allow", message: "reviewed" });
  });

  it("leaves an ask for a human when the reviewer escalates or fails", async () => {
    const { context, hooks } = createContext();
    const { plugin, review } = createPlugin({ verdict: "escalate" });
    await plugin.setup(context as never);

    const escalated = askEvent();
    await hooks["permission.evaluate"]?.(escalated);
    expect(escalated.effect).toBe("ask");

    review.mockRejectedValueOnce(new Error("timeout"));
    const failed = askEvent();
    await hooks["permission.evaluate"]?.(failed);
    expect(failed.effect).toBe("ask");
  });

  it("does not review evaluations that already resolved or come from the reviewer", async () => {
    const { context, hooks } = createContext();
    const { plugin, review } = createPlugin({ verdict: "deny" });
    await plugin.setup(context as never);

    const allowed = askEvent({ effect: "allow" });
    await hooks["permission.evaluate"]?.(allowed);
    await hooks["permission.evaluate"]?.(askEvent({ sessionID: "review-session" }));

    expect(review).not.toHaveBeenCalled();
    expect(allowed.effect).toBe("allow");
  });

  it("skips evaluations raised under the reviewer agent and keeps its prompts out of intents", async () => {
    const { context, hooks } = createContext();
    const { plugin, review, isReviewerSession } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);
    await hooks["session.prompt"]?.({ sessionID: "review-session", prompt: { text: "review" } });
    await hooks["session.prompt"]?.({ sessionID: "session-1", prompt: { text: "user ask" } });

    await hooks["permission.evaluate"]?.(
      askEvent({ sessionID: "orphan", agent: "auto-approval-reviewer" }),
    );
    expect(review).not.toHaveBeenCalled();

    await hooks["permission.evaluate"]?.(askEvent());
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ userIntent: "user ask" }));
    expect(isReviewerSession).toHaveBeenCalledWith({ sessionID: "review-session" });
  });

  it("reviews an agent that merely shares the reviewer's name under the decision backend", async () => {
    const { context, hooks } = createContext({
      options: {
        reviewer: {
          backend: "decision",
          decision: { provider: "typesafe", apiKey: "test-key" },
        },
      },
    });
    const { plugin, review } = createPlugin({ verdict: "deny" });
    await plugin.setup(context as never);

    await hooks["permission.evaluate"]?.(
      askEvent({ sessionID: "session-1", agent: "auto-approval-reviewer" }),
    );

    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    // A decision model does not review with the session's model, so it is not looked up.
    expect(context.session.get).not.toHaveBeenCalled();
  });

  it("reviews without a model when the session lookup fails", async () => {
    const { context, hooks, session } = createContext();
    session.get.mockRejectedValueOnce(new Error("gone"));
    const { plugin, review } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    const event = askEvent();
    await hooks["permission.evaluate"]?.(event);

    expect(review).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    expect(event.effect).toBe("allow");
  });

  it("never turns a deny verdict into allow", async () => {
    const { context, hooks } = createContext();
    const { plugin } = createPlugin({ verdict: "deny" });
    await plugin.setup(context as never);

    const event = askEvent();
    await hooks["permission.evaluate"]?.(event);

    expect(event.effect).toBe("ask");
  });

  it("registers both native permission and tool hooks in all-tools mode", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    expect(hooks["permission.evaluate"]).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
  });

  it.each(["shell", "read"])(
    "satisfies native asks for an approved %s subagent tool call without a second review",
    async (tool) => {
      const { context, hooks } = createContext({ options: { mode: "all-tools" } });
      const { plugin, review } = createPlugin({ verdict: "allow" });
      await plugin.setup(context as never);

      const call = {
        sessionID: "session-1",
        agent: "explore",
        messageID: "msg-1",
        id: "call-1",
        tool,
        input: tool === "shell" ? { command: "ls -la" } : { filePath: "README.md" },
      };
      const native = (action: string) =>
        askEvent({
          sessionID: call.sessionID,
          agent: call.agent,
          action,
          effect: "ask",
          source: { type: "tool", messageID: call.messageID, id: call.id },
        });

      const premature = native(tool);
      await hooks["permission.evaluate"]?.(premature);
      expect(premature.effect).toBe("ask");

      await hooks["tool.execute.before"]?.(call);
      const externalDirectory = native("external_directory");
      const primary = native(tool);
      await hooks["permission.evaluate"]?.(externalDirectory);
      await hooks["permission.evaluate"]?.(primary);
      expect(externalDirectory.effect).toBe("allow");
      expect(primary.effect).toBe("allow");
      expect(review).toHaveBeenCalledTimes(1);

      const denied = native(tool);
      denied.effect = "deny";
      await hooks["permission.evaluate"]?.(denied);
      expect(denied.effect).toBe("deny");

      await hooks["tool.execute.after"]?.({ ...call, status: "completed", result: {} });
      const after = native(tool);
      await hooks["permission.evaluate"]?.(after);
      expect(after.effect).toBe("ask");
    },
  );

  it("scopes native grants to the exact session, agent, message and call id", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    await hooks["tool.execute.before"]?.({
      sessionID: "session-1",
      agent: "explore",
      messageID: "msg-1",
      id: "call-1",
      tool: "shell",
      input: { command: "ls" },
    });

    const native = (overrides: Record<string, unknown> = {}) =>
      askEvent({
        sessionID: "session-1",
        agent: "explore",
        action: "shell",
        source: { type: "tool", messageID: "msg-1", id: "call-1" },
        ...overrides,
      });
    const mismatches = [
      native({ sessionID: "session-other" }),
      native({ agent: "build" }),
      native({ source: { type: "tool", messageID: "msg-other", id: "call-1" } }),
      native({ source: { type: "tool", messageID: "msg-1", id: "call-other" } }),
      native({ source: undefined }),
    ];
    for (const event of mismatches) {
      await hooks["permission.evaluate"]?.(event);
      expect(event.effect).toBe("ask");
    }
    const matched = native();
    await hooks["permission.evaluate"]?.(matched);
    expect(matched.effect).toBe("allow");
  });

  it.each(["deny", "escalate"] as const)(
    "never grants native permissions after an AI %s verdict",
    async (verdict) => {
      const { context, hooks } = createContext({ options: { mode: "all-tools" } });
      const { plugin } = createPlugin({ verdict });
      await plugin.setup(context as never);

      await expect(
        hooks["tool.execute.before"]?.({
          sessionID: "session-1",
          agent: "explore",
          messageID: "msg-1",
          id: "call-1",
          tool: "shell",
          input: { command: "git push" },
        }),
      ).rejects.toThrow("Auto-approval reviewer");
      const native = askEvent({
        agent: "explore",
        action: "shell",
        source: { type: "tool", messageID: "msg-1", id: "call-1" },
      });
      await hooks["permission.evaluate"]?.(native);
      expect(native.effect).toBe("ask");
    },
  );

  it("clears the native grant on an errored tool call", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    const call = {
      sessionID: "session-1",
      agent: "explore",
      messageID: "msg-1",
      id: "call-1",
      tool: "shell",
      input: { command: "ls" },
    };
    await hooks["tool.execute.before"]?.(call);
    await hooks["tool.execute.after"]?.({ ...call, status: "error", error: new Error("oops") });
    const native = askEvent({
      agent: "explore",
      action: "shell",
      source: { type: "tool", messageID: "msg-1", id: "call-1" },
    });
    await hooks["permission.evaluate"]?.(native);
    expect(native.effect).toBe("ask");
  });

  it("expires orphaned grants if the after hook never fires", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);
    const call = {
      sessionID: "session-1",
      agent: "explore",
      messageID: "msg-1",
      id: "call-1",
      tool: "shell",
      input: { command: "ls" },
    };
    await hooks["tool.execute.before"]?.(call);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      const native = askEvent({
        agent: "explore",
        action: "shell",
        source: { type: "tool", messageID: "msg-1", id: "call-1" },
      });
      await hooks["permission.evaluate"]?.(native);
      expect(native.effect).toBe("ask");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks a tool call when all-tools review escalates", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "escalate" });
    await plugin.setup(context as never);

    await expect(
      hooks["tool.execute.before"]?.({
        tool: "bash",
        sessionID: "session-1",
        input: { command: "git push" },
      }),
    ).rejects.toThrow("requires human review");
  });

  it("permits a tool call when all-tools review allows it", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin, review } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    await expect(
      hooks["tool.execute.before"]?.({
        tool: "read",
        sessionID: "session-1",
        input: { filePath: "README.md" },
      }),
    ).resolves.toBeUndefined();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tool-call",
        action: "read",
        resource: { filePath: "README.md" },
      }),
    );
  });

  it("reports a reviewer failure as a blocked tool call", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin, review } = createPlugin({ verdict: "allow" });
    review.mockRejectedValueOnce(new Error("Reviewer timed out."));
    await plugin.setup(context as never);

    await expect(
      hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "session-1", input: {} }),
    ).rejects.toThrow(
      "Auto-approval reviewer failed; human review is required. Reviewer timed out.",
    );
  });
});

describe("V2 session client", () => {
  it("creates a reviewer session, waits for the reply, and reads the assistant text", async () => {
    const { context, session } = createContext();
    const client = createV2SessionClient(context as never);

    const created = await client.create({ model: { providerID: "openai", modelID: "gpt-5.6" } });
    const text = await client.prompt({ sessionID: created.sessionID, text: "review this" });

    expect(created).toEqual({ sessionID: "review-session" });
    expect(session.create).toHaveBeenCalledWith({
      title: "Auto-approval review",
      agent: "auto-approval-reviewer",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "allow" },
      ],
      model: { providerID: "openai", id: "gpt-5.6" },
    });
    expect(session.prompt).toHaveBeenCalledWith({
      sessionID: "review-session",
      text: "review this",
    });
    expect(session.wait).toHaveBeenCalledWith({ sessionID: "review-session" });
    expect(text).toBe('{"verdict":"allow","reason":"safe"}');
  });

  it("omits the model when none is known", async () => {
    const { context, session } = createContext();
    const client = createV2SessionClient(context as never);

    await client.create({});

    expect(session.create).toHaveBeenCalledWith({
      title: "Auto-approval review",
      agent: "auto-approval-reviewer",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "allow" },
      ],
    });
  });

  it("returns only the final assistant reply", async () => {
    const { context, session } = createContext();
    session.context.mockResolvedValueOnce([
      { type: "assistant", content: [{ type: "text", text: "Let me read {the file} first." }] },
      { type: "user", text: "tool result" },
      { type: "assistant", content: [{ type: "text", text: '{"verdict":"deny","reason":"no"}' }] },
    ]);
    const client = createV2SessionClient(context as never);

    await expect(client.prompt({ sessionID: "review-session", text: "" })).resolves.toBe(
      '{"verdict":"deny","reason":"no"}',
    );
  });

  it("surfaces a failed assistant turn instead of an empty reply", async () => {
    const { context, session } = createContext();
    session.context.mockResolvedValueOnce([
      { type: "assistant", content: [], error: { name: "ProviderError", message: "no model" } },
    ]);
    const client = createV2SessionClient(context as never);

    await expect(client.prompt({ sessionID: "review-session", text: "" })).rejects.toThrow(
      "Reviewer session failed: no model",
    );
  });

  it("interrupts the session on abort", async () => {
    const { context, session } = createContext();
    const client = createV2SessionClient(context as never);

    await client.abort({ sessionID: "review-session" });

    expect(session.interrupt).toHaveBeenCalledWith({ sessionID: "review-session" });
  });
});
