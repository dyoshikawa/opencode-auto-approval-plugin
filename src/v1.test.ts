import { describe, expect, it, vi } from "vitest";

import { Reviewer } from "./reviewer.js";
import { createV1Plugin, createV1SessionClient, reviewerAgentConfig } from "./v1.js";

type ReviewerVerdict = "allow" | "deny" | "escalate";

function createContext() {
  const reply = vi.fn(async () => true);
  return {
    context: {
      client: {
        postSessionIdPermissionsPermissionId: reply,
      },
      directory: "/workspace",
    },
    reply,
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
  it("recovers current-session history without a captured prompt after restart", async () => {
    const { context } = createContext();
    const messages = vi.fn(async () => ({
      data: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{ type: "text", text: "I propose pwd" }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "execute that plan" }],
        },
      ],
    }));
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(
      { ...context, client: { ...context.client, session: { messages } } } as never,
      {},
    );
    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: {
          id: "p",
          sessionID: "session-1",
          permission: "bash",
          patterns: ["pwd"],
          metadata: { command: "pwd" },
        },
      },
    } as never);
    expect(messages).toHaveBeenCalledWith({
      path: { id: "session-1" },
      query: { directory: "/workspace", limit: 32 },
    });
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "execute that plan",
        conversation: {
          turns: [
            { role: "assistant", text: "I propose pwd" },
            { role: "user", text: "execute that plan" },
          ],
          incomplete: true,
        },
      }),
    );
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

  it.each([
    { type: "permission.asked", fields: { permission: "bash", patterns: ["pwd"] } },
    { type: "permission.updated", fields: { type: "bash", pattern: ["pwd"] } },
    {
      type: "permission.asked",
      fields: { permission: "bash", patterns: ["pwd"], type: "legacy", pattern: "ignored" },
    },
  ])("normalizes $type fields before review and audit", async ({ type, fields }) => {
    const { context, reply } = createContext();
    const log = vi.fn();
    const prompt = vi.fn(async () => '{"verdict":"allow","reason":"read-only"}');
    const review = vi.fn();
    const plugin = createV1Plugin({
      createReviewer: ({ configuration }) => {
        const reviewer = new Reviewer({
          configuration,
          client: {
            create: async () => ({ sessionID: "review-session" }),
            prompt,
            abort: async () => undefined,
          },
          auditLogger: { log },
        });
        review.mockImplementation((request) => reviewer.review(request));
        return { review, isReviewerSession: () => false } as never;
      },
    });
    const hooks = await plugin(context as never, {});

    await hooks["chat.message"]?.({ sessionID: "session-1" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "run pwd" }] as never,
    });
    await hooks.event?.({
      event: {
        // Not yet in the pinned @opencode-ai/plugin event union, but emitted
        // by opencode >= 1.18 at runtime.
        type: type as "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          ...fields,
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      } as never,
    });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bash", resource: { pattern: ["pwd"], metadata: {} } }),
    );
    expect(log).toHaveBeenCalledWith({
      entry: expect.objectContaining({ action: "bash", verdict: "allow", confidence: null }),
    });
    expect(reply).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/workspace" },
      body: { response: "once" },
    });
  });

  it.each([undefined, "", "   ", 42])(
    "leaves missing or invalid permission %s for a human",
    async (permission) => {
      const { context, reply } = createContext();
      const { plugin, review } = createPlugin({ verdict: "allow" });
      const hooks = await plugin(context as never, {});
      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: { id: "permission-1", sessionID: "session-1", permission, patterns: ["pwd"] },
        } as never,
      });
      expect(review).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    },
  );

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
