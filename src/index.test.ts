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

  it("reviews through the Jev API when the jev backend is configured", async () => {
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
          reviewer: { backend: "jev", jev: { apiKey: "test-key" } },
        },
        location: { directory: "/workspace" },
        session,
        agent: { transform: async () => registration },
        permission: { hook: async () => registration },
        tool: { hook: register },
      } as never);

      await expect(
        hooks["execute.before"]?.({ sessionID: "s", tool: "bash", input: { command: "rm -rf /" } }),
      ).rejects.toThrow("Auto-approval reviewer denied: Jev chose deny");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
    expect(session.create).not.toHaveBeenCalled();
  });
});
