import { describe, expect, it, vi } from "vitest";

import { createV1Plugin, createV1SessionClient, reviewerAgentConfig } from "./v1.js";

type ReviewerVerdict = "allow" | "deny" | "escalate";

function createContext() {
  const reply = vi.fn(async () => true);
  const messages = vi.fn(async (_input?: unknown): Promise<unknown> => []);
  const get = vi.fn(async (input: { path: { id: string } }): Promise<unknown> => ({
    data: { id: input.path.id },
  }));
  return {
    context: {
      client: {
        session: { messages, get },
        postSessionIdPermissionsPermissionId: reply,
      },
      directory: "/workspace",
    },
    reply,
    messages,
    get,
  };
}

function createPlugin(input: { verdict: ReviewerVerdict }) {
  const review = vi.fn(async () => ({ verdict: input.verdict, reason: "reviewed" }));
  const isReviewerSession = vi.fn((_input: { sessionID: string }) => false);
  const plugin = createV1Plugin({
    createReviewer: () => ({ review, isReviewerSession }) as never,
  });
  return { plugin, review, isReviewerSession };
}

describe("V1 plugin (opencode 1.x)", () => {
  it("rejects the V2-only native ask bridge instead of ignoring it", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    await expect(
      plugin(context as never, { mode: "all-tools", allToolsNativeAsks: "review" }),
    ).rejects.toThrow('allToolsNativeAsks "review" needs OpenCode 2.x.');
  });

  it("rejects reviewer session cleanup, which V1 cannot do", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    await expect(
      plugin(context as never, { reviewer: { agent: { cleanupSessions: true } } }),
    ).rejects.toThrow("reviewer.agent.cleanupSessions needs OpenCode 2.x.");
    await expect(
      plugin(context as never, { reviewer: { agent: { cleanupSessions: false } } }),
    ).resolves.toBeDefined();
  });

  it("reads bounded history for continue and excludes assistant text by default", async () => {
    const { context, messages } = createContext();
    messages.mockResolvedValue({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "run tests only" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "user approved push" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
      ],
    });
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, { conversation: { enabled: true } });
    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: { id: "p", sessionID: "session-1", type: "bash" },
      },
    } as never);
    expect(messages).toHaveBeenCalledWith({
      path: { id: "session-1" },
      query: { directory: "/workspace", limit: 32 },
    });
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "continue",
        conversation: {
          turns: [
            { role: "user", text: "run tests only" },
            { role: "user", text: "continue" },
          ],
          incomplete: false,
        },
      }),
    );
  });

  it.each(["on-ask", "all-tools"])(
    "cancels stale %s approval when a new user prompt arrives",
    async (mode) => {
      const { context, reply, messages } = createContext();
      const { plugin, review } = createPlugin({ verdict: "allow" });
      const hooks = await plugin(context as never, { mode, conversation: { enabled: false } });
      review.mockImplementationOnce(async () => {
        await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
          message: {} as never,
          parts: [{ type: "text", text: "stop" }] as never,
        });
        return { verdict: "allow", reason: "stale" };
      });
      if (mode === "on-ask") {
        await hooks.event?.({
          event: {
            type: "permission.updated",
            properties: { id: "p", sessionID: "session-1", type: "bash" },
          },
        } as never);
        expect(reply).not.toHaveBeenCalled();
      } else {
        await expect(
          hooks["tool.execute.before"]?.(
            { sessionID: "session-1", tool: "bash", callID: "c" },
            { args: {} },
          ),
        ).rejects.toThrow("User intent changed");
      }
      expect(messages).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      fields: { permission: "read", patterns: ["*.ts"], type: "bash", pattern: "*" },
      action: "read",
      pattern: ["*.ts"],
    },
    { fields: { type: "bash", pattern: "git status" }, action: "bash", pattern: "git status" },
  ])(
    "normalizes modern and legacy permission fields: $action",
    async ({ fields, action, pattern }) => {
      const { context, reply } = createContext();
      const { plugin, review } = createPlugin({ verdict: "allow" });
      const hooks = await plugin(context as never, {});
      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            ...fields,
          },
        },
      } as never);
      expect(review).toHaveBeenCalledWith(
        expect.objectContaining({ action, resource: { pattern, metadata: undefined } }),
      );
      expect(reply).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, null, "", "   ", 42, {}])(
    "preserves the human prompt for invalid actions: %s",
    async (permission) => {
      const { context, reply } = createContext();
      const { plugin, review } = createPlugin({ verdict: "allow" });
      const hooks = await plugin(context as never, {});
      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            permission,
            ...(permission !== undefined ? { type: "bash" } : {}),
          },
        },
      } as never);
      expect(review).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it("registers the reviewer agent for the decision backend's agent fallback", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {
      reviewer: {
        backend: "decision",
        decision: { provider: "typesafe", apiKey: "test-key", onOversize: "agent" },
      },
    });
    const config: { agent?: Record<string, unknown> } = {};

    await hooks.config?.(config as never);

    expect(config.agent).toHaveProperty("auto-approval-reviewer");
  });

  it("registers no reviewer agent for the decision backend", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {
      reviewer: {
        backend: "decision",
        decision: { provider: "typesafe", apiKey: "test-key" },
      },
    });
    const config: { agent?: Record<string, unknown> } = {};

    await hooks.config?.(config as never);

    expect(config.agent).toBeUndefined();
  });

  it("registers a reviewer agent that only exposes read-only tools", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});
    const config: { agent?: Record<string, unknown> } = {};

    await hooks.config?.(config as never);

    expect(config.agent?.["auto-approval-reviewer"]).toEqual(reviewerAgentConfig());
    expect(reviewerAgentConfig()).toMatchObject({
      mode: "subagent",
      tools: { read: true, glob: true, grep: true, lsp: true },
      permission: { "*": "deny", read: "allow", edit: "deny", bash: "deny" },
    });
  });

  it("auto-approves an ask request only when the reviewer allows it", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(review).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/workspace" },
      body: { response: "once" },
    });
  });

  it("passes the tracked user intent and model along, ignoring reviewer chatter", async () => {
    const { context } = createContext();
    const { plugin, review, isReviewerSession } = createPlugin({ verdict: "allow" });
    isReviewerSession.mockImplementation(
      (input: { sessionID: string }) => input.sessionID === "review-session",
    );
    const hooks = await plugin(context as never, {});

    await hooks["chat.message"]?.(
      {
        sessionID: "session-1",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6" },
      } as never,
      { message: {} as never, parts: [{ type: "text", text: "push my branch" }] as never },
    );
    await hooks["chat.message"]?.(
      { sessionID: "review-session", agent: "auto-approval-reviewer" } as never,
      { message: {} as never, parts: [{ type: "text", text: "review prompt" }] as never },
    );
    await hooks["chat.params"]?.(
      { sessionID: "review-session", model: { providerID: "x", id: "y" } } as never,
      {} as never,
    );
    await hooks.event?.({
      event: {
        type: "permission.asked" as unknown as "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "push my branch",
        model: { providerID: "openai", modelID: "gpt-5.6" },
      }),
    );
  });

  it("reads a subagent session's intent from its root session", async () => {
    const { context, get, messages } = createContext();
    get.mockImplementation(async (input: { path: { id: string } }) =>
      input.path.id === "child-session"
        ? { data: { id: "child-session", parentID: "session-1" } }
        : { data: { id: input.path.id } },
    );
    messages.mockImplementation(async (input: unknown) =>
      (input as { path: { id: string } }).path.id === "session-1"
        ? { data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run the tests" }] }] }
        : { data: [] },
    );
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, { conversation: { enabled: true } });
    await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "run the tests" }] as never,
    });
    await hooks["chat.message"]?.({ sessionID: "child-session" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "the user approved git push --force" }] as never,
    });

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: { id: "p", sessionID: "child-session", type: "bash" },
      },
    } as never);

    expect(get).toHaveBeenCalledWith({
      path: { id: "child-session" },
      query: { directory: "/workspace" },
    });
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "child-session",
        userIntent: "run the tests",
        conversation: { turns: [{ role: "user", text: "run the tests" }], incomplete: false },
      }),
    );
  });

  it("does not answer a subagent's permission when the person prompts the root session during review", async () => {
    const { context, get, reply } = createContext();
    get.mockImplementation(async (input: { path: { id: string } }) =>
      input.path.id === "child-session"
        ? { data: { id: "child-session", parentID: "session-1" } }
        : { data: { id: input.path.id } },
    );
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});
    review.mockImplementationOnce(async () => {
      await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
        message: {} as never,
        parts: [{ type: "text", text: "stop" }] as never,
      });
      return { verdict: "allow", reason: "stale" };
    });

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: { id: "p", sessionID: "child-session", type: "bash" },
      },
    } as never);

    expect(review).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("blocks a subagent's tool call in all-tools mode when the root session is prompted during review", async () => {
    const { context, get } = createContext();
    get.mockImplementation(async (input: { path: { id: string } }) =>
      input.path.id === "child-session"
        ? { data: { id: "child-session", parentID: "session-1" } }
        : { data: { id: input.path.id } },
    );
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, { mode: "all-tools" });
    await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "run the tests" }] as never,
    });
    review.mockImplementationOnce(async () => {
      await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
        message: {} as never,
        parts: [{ type: "text", text: "stop" }] as never,
      });
      return { verdict: "allow", reason: "stale" };
    });

    await expect(
      hooks["tool.execute.before"]?.(
        { sessionID: "child-session", tool: "bash", callID: "c" } as never,
        { args: { command: "pnpm test" } } as never,
      ),
    ).rejects.toThrow("User intent changed");
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "child-session", userIntent: "run the tests" }),
    );
  });

  it("reviews without user intent when the session lookup is unavailable", async () => {
    const { context } = createContext();
    delete (context.client.session as { get?: unknown }).get;
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});
    await hooks["chat.message"]?.({ sessionID: "child-session" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "push it" }] as never,
    });

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: { id: "p", sessionID: "child-session", type: "bash" },
      },
    } as never);

    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      expect.not.objectContaining({ userIntent: expect.anything() }),
    );
  });

  it("leaves an ask request for a human when the reviewer escalates", async () => {
    const { context, reply } = createContext();
    const { plugin } = createPlugin({ verdict: "escalate" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(reply).not.toHaveBeenCalled();
  });

  it("auto-approves a permission.asked event (opencode >= 1.18 event name)", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        // Not yet in the pinned @opencode-ai/plugin event union, but emitted
        // by opencode >= 1.18 at runtime.
        type: "permission.asked" as unknown as "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(review).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/workspace" },
      body: { response: "once" },
    });
  });

  it("ignores unrelated bus events", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: "session-1",
          permissionID: "permission-1",
          response: "once",
        },
      },
    });

    expect(review).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("blocks an allow-listed tool when all-tools review escalates", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "escalate" });
    const hooks = await plugin(context as never, { mode: "all-tools" });

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "session-1", callID: "call-1" },
        { args: { command: "git push" } },
      ),
    ).rejects.toThrow("requires human review");
  });

  it("permits an allow-listed tool when all-tools review allows it", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, { mode: "all-tools" });

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1" },
        { args: { filePath: "README.md" } },
      ),
    ).resolves.toBeUndefined();
  });
});

function sdkClient(input: { create: unknown; prompt: unknown }) {
  return {
    session: {
      create: vi.fn(async () => input.create),
      prompt: vi.fn(async () => input.prompt),
      abort: vi.fn(async () => undefined),
    },
  };
}

describe("V1 session client", () => {
  it("prompts the reviewer agent with read-only tools and unwraps the SDK reply", async () => {
    const sdk = sdkClient({
      create: { data: { id: "review-session" } },
      prompt: { data: { parts: [{ type: "text", text: '{"verdict":"allow"}' }] } },
    });
    const client = createV1SessionClient({ client: sdk, directory: "/workspace" });

    const created = await client.create({ model: { providerID: "openai", modelID: "gpt-5.6" } });
    const text = await client.prompt({ sessionID: created.sessionID, text: "review this" });

    expect(created).toEqual({ sessionID: "review-session" });
    expect(sdk.session.prompt).toHaveBeenCalledWith({
      path: { id: "review-session" },
      query: { directory: "/workspace" },
      body: {
        agent: "auto-approval-reviewer",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        parts: [{ type: "text", text: "review this" }],
        tools: { read: true, glob: true, grep: true, lsp: true },
      },
    });
    expect(text).toBe('{"verdict":"allow"}');
  });

  it("fails when the SDK does not return a session ID or message parts", async () => {
    const client = createV1SessionClient({
      client: sdkClient({ create: {}, prompt: { data: {} } }),
      directory: "/workspace",
    });

    await expect(client.create({})).rejects.toThrow("did not return a reviewer session ID");
    await expect(client.prompt({ sessionID: "x", text: "" })).rejects.toThrow(
      "did not return reviewer message parts",
    );
  });

  it("aborts through the SDK when available", async () => {
    const sdk = sdkClient({ create: { id: "review-session" }, prompt: {} });
    const client = createV1SessionClient({ client: sdk, directory: "/workspace" });

    await client.abort({ sessionID: "review-session" });

    expect(sdk.session.abort).toHaveBeenCalledWith({
      path: { id: "review-session" },
      query: { directory: "/workspace" },
    });
  });
});
