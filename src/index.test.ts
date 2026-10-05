import { describe, expect, it, vi } from "vitest";

import plugin, { createAutoApprovalPlugin } from "./index.js";

describe("plugin entrypoint", () => {
  it("exposes the V2 definition and a V1 server() entrypoint from one default export", () => {
    expect(plugin.id).toBe("opencode-auto-approval-plugin");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("hands the injected reviewer factory to both generations", async () => {
    const createReviewer = vi.fn(() => ({ review: vi.fn(), isReviewerSession: () => false }));
    const custom = createAutoApprovalPlugin({
      dependencies: { createReviewer: createReviewer as never },
    });
    const registration = { dispose: async () => undefined };
    const v2Context = {
      options: {},
      location: { directory: "/workspace" },
      session: { hook: async () => registration },
      agent: { transform: async () => registration },
      permission: { hook: async () => registration },
      tool: { hook: async () => registration },
    };

    await custom.setup(v2Context as never);
    await custom.server({ client: {}, directory: "/workspace" } as never, {});

    expect(createReviewer).toHaveBeenCalledTimes(2);
  });

  it("reviews through the decision model API when that backend is configured", async () => {
    const hooks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    const registration = { dispose: async () => undefined };
    const register = async (
      name: string,
      callback: (event: Record<string, unknown>) => Promise<void>,
    ) => {
      hooks[name] = callback;
      return registration;
    };
    const fetch = vi.fn(async () =>
      Response.json({ answers: { verdict: { choice: "deny", probabilities: { deny: 1 } } } }),
    );
    vi.stubGlobal("fetch", fetch);
    const session = { hook: async () => registration, create: vi.fn() };

    try {
      await plugin.setup({
        options: {
          mode: "all-tools",
          reviewer: {
            backend: "decision",
            decision: { provider: "typesafe", apiKey: "test-key" },
          },
        },
        location: { directory: "/workspace" },
        session,
        agent: { transform: async () => registration },
        permission: { hook: async () => registration },
        tool: { hook: register },
      } as never);

      await expect(
        hooks["execute.before"]?.({ sessionID: "s", tool: "bash", input: { command: "rm -rf /" } }),
      ).rejects.toThrow("Auto-approval reviewer denied: jev-latest chose deny");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
    expect(session.create).not.toHaveBeenCalled();
  });

  it("hands an operation too large for the decision model to the chat fallback", async () => {
    const hooks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    const registration = { dispose: async () => undefined };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/chat/completions")) {
        return Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 });
      }
      const prompt: string = JSON.parse(String(init?.body)).messages[1].content;
      const check = /Review check: "([\da-f-]+)"/.exec(prompt)?.[1];
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ verdict: "allow", reason: "read it whole", check }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await plugin.setup({
        options: {
          mode: "all-tools",
          reviewer: {
            backend: "decision",
            recordUsage: false,
            decision: { provider: "typesafe", apiKey: "test-key", onOversize: "chat" },
            chat: { apiKey: "or-key", baseURL: "https://openrouter.ai/api/v1", model: "m" },
          },
        },
        location: { directory: "/workspace" },
        session: { hook: async () => registration, create: vi.fn() },
        agent: { transform: async () => registration },
        permission: { hook: async () => registration },
        tool: {
          hook: async (
            name: string,
            callback: (event: Record<string, unknown>) => Promise<void>,
          ) => {
            hooks[name] = callback;
            return registration;
          },
        },
      } as never);

      await expect(
        hooks["execute.before"]?.({ sessionID: "s", tool: "bash", input: { command: "ls" } }),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.typesafe.ai/v1/systemone",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });
});
