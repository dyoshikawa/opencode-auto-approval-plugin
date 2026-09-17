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
    context: vi.fn(async () => [
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

  it("never turns a deny verdict into allow", async () => {
    const { context, hooks } = createContext();
    const { plugin } = createPlugin({ verdict: "deny" });
    await plugin.setup(context as never);

    const event = askEvent();
    await hooks["permission.evaluate"]?.(event);

    expect(event.effect).toBe("ask");
  });

  it("does not register the permission hook in all-tools mode", async () => {
    const { context, hooks } = createContext({ options: { mode: "all-tools" } });
    const { plugin } = createPlugin({ verdict: "allow" });
    await plugin.setup(context as never);

    expect(hooks["permission.evaluate"]).toBeUndefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
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
    });
  });

  it("interrupts the session on abort", async () => {
    const { context, session } = createContext();
    const client = createV2SessionClient(context as never);

    await client.abort({ sessionID: "review-session" });

    expect(session.interrupt).toHaveBeenCalledWith({ sessionID: "review-session" });
  });
});
