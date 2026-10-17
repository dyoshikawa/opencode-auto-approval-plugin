import { describe, expect, it, vi } from "vitest";

import { postJSON } from "./http.js";

describe("postJSON", () => {
  it("sends extra headers without letting them replace the key or the content type", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));

    await postJSON({
      fetch,
      url: "https://api.example/v1",
      apiKey: "real-key",
      body: {},
      headers: {
        "X-Feature": "true",
        Authorization: "Bearer other-key",
        "Content-Type": "text/plain",
      },
      timeoutMs: 1_000,
      label: "Test",
    });

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-feature")).toBe("true");
    expect(headers.get("authorization")).toBe("Bearer real-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("sends the key as x-api-key when asked, and never an extra key header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));

    await postJSON({
      fetch,
      url: "https://api.example/v1",
      apiKey: "real-key",
      auth: "x-api-key",
      body: {},
      headers: { "X-Api-Key": "other-key", Authorization: "Bearer other-key" },
      timeoutMs: 1_000,
      label: "Test",
    });

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("real-key");
    expect(headers.get("authorization")).toBeNull();
  });
});
