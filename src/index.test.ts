import { describe, expect, it } from "vitest";

import plugin from "./index.js";

describe("plugin entrypoint", () => {
  it("exposes the V2 definition and a V1 server() entrypoint from one default export", () => {
    expect(plugin.id).toBe("opencode-auto-approval-plugin");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });
});
