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
});
