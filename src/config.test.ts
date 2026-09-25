import { describe, expect, it } from "vitest";

import { parsePluginConfiguration } from "./config.js";

function jevOptions(jev: Record<string, unknown> = {}) {
  return { reviewer: { backend: "jev", jev } };
}

describe("parsePluginConfiguration", () => {
  it("uses the safe on-ask defaults", () => {
    expect(parsePluginConfiguration({ options: {}, env: {} })).toEqual({
      mode: "on-ask",
      reviewer: { backend: "opencode", timeoutMs: 30_000 },
    });
  });

  it("accepts an independent reviewer model", () => {
    expect(
      parsePluginConfiguration({
        options: {
          mode: "all-tools",
          reviewer: {
            model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
            timeoutMs: 12_000,
          },
        },
      }),
    ).toEqual({
      mode: "all-tools",
      reviewer: {
        backend: "opencode",
        model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
        timeoutMs: 12_000,
      },
    });
  });

  it("rejects an unknown mode", () => {
    expect(() => parsePluginConfiguration({ options: { mode: "all" } })).toThrow(
      "Invalid auto-approval plugin options",
    );
  });

  it("does not require Jev credentials for the opencode backend", () => {
    expect(
      parsePluginConfiguration({ options: { reviewer: { backend: "opencode" } }, env: {} })
        .reviewer,
    ).not.toHaveProperty("jev");
  });

  describe("jev backend", () => {
    it("reads the key and base URL from the environment with defaults", () => {
      expect(
        parsePluginConfiguration({
          options: jevOptions(),
          env: { TYPESAFE_API_KEY: "env-key" },
        }).reviewer.jev,
      ).toEqual({
        apiKey: "env-key",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest",
        minAllowProbability: 0.6,
      });
    });

    it("prefers plugin options over the environment", () => {
      expect(
        parsePluginConfiguration({
          options: jevOptions({
            apiKey: "option-key",
            baseURL: "http://localhost:8787",
            model: "jev-1.13.0",
            minAllowProbability: 0.8,
          }),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://proxy.example" },
        }).reviewer.jev,
      ).toEqual({
        apiKey: "option-key",
        endpoint: "http://localhost:8787/v1/systemone",
        model: "jev-1.13.0",
        minAllowProbability: 0.8,
      });
    });

    it("takes the base URL from the environment", () => {
      expect(
        parsePluginConfiguration({
          options: jevOptions(),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://proxy.example/" },
        }).reviewer.jev?.endpoint,
      ).toBe("https://proxy.example/v1/systemone");
    });

    it("never sends an option key to the environment's base URL", () => {
      expect(
        parsePluginConfiguration({
          options: jevOptions({ apiKey: "option-key" }),
          env: { TYPESAFE_BASE_URL: "https://attacker.example" },
        }).reviewer.jev?.endpoint,
      ).toBe("https://api.typesafe.ai/v1/systemone");
    });

    it("refuses an option base URL for the environment's key", () => {
      expect(() =>
        parsePluginConfiguration({
          options: jevOptions({ baseURL: "https://attacker.example" }),
          env: { TYPESAFE_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.jev.baseURL needs reviewer.jev.apiKey");
    });

    it("trims whitespace around the key", () => {
      expect(
        parsePluginConfiguration({ options: jevOptions(), env: { TYPESAFE_API_KEY: " env-key\n" } })
          .reviewer.jev?.apiKey,
      ).toBe("env-key");
    });

    it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
      "allows plain HTTP to the loopback origin %s",
      (baseURL) => {
        expect(
          parsePluginConfiguration({ options: jevOptions({ apiKey: "key", baseURL }), env: {} })
            .reviewer.jev?.endpoint,
        ).toBe(`${baseURL}/v1/systemone`);
      },
    );

    it("treats a blank option key as absent", () => {
      expect(
        parsePluginConfiguration({
          options: jevOptions({ apiKey: "  " }),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: " " },
        }).reviewer.jev,
      ).toMatchObject({ apiKey: "env-key", endpoint: "https://api.typesafe.ai/v1/systemone" });
      expect(() =>
        parsePluginConfiguration({
          options: jevOptions({ apiKey: "  ", baseURL: "https://attacker.example" }),
          env: { TYPESAFE_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.jev.baseURL needs reviewer.jev.apiKey");
    });

    it("fails fast without an API key", () => {
      expect(() =>
        parsePluginConfiguration({ options: jevOptions(), env: { TYPESAFE_API_KEY: "  " } }),
      ).toThrow("needs reviewer.jev.apiKey or TYPESAFE_API_KEY");
    });

    it.each([
      ["not a URL", "api.typesafe.ai"],
      ["a non-HTTP scheme", "ftp://api.typesafe.ai"],
      // Assembled so secret scanners do not read the test URL as a credential.
      ["credentials", `https://user:${"x"}@api.typesafe.ai`],
      ["a query", "https://api.typesafe.ai/?region=eu"],
      ["a fragment", "https://api.typesafe.ai/#x"],
      ["a path", "https://api.typesafe.ai/v1/systemone"],
      ["plain HTTP to a remote host", "http://api.typesafe.ai"],
    ])("rejects a base URL with %s", (_label, baseURL) => {
      expect(() =>
        parsePluginConfiguration({ options: jevOptions({ apiKey: "key", baseURL }), env: {} }),
      ).toThrow("Invalid auto-approval plugin options");
    });

    it("rejects an out-of-range allow threshold", () => {
      expect(() =>
        parsePluginConfiguration({
          options: jevOptions({ apiKey: "key", minAllowProbability: 1.5 }),
          env: {},
        }),
      ).toThrow("Invalid auto-approval plugin options");
    });
  });
});
