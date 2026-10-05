import { describe, expect, it } from "vitest";

import { parsePluginConfiguration } from "./config.js";

function typeSafeOptions(options: Record<string, unknown> = {}) {
  return {
    reviewer: { backend: "decision", decision: { provider: "typesafe", ...options } },
  };
}

function cloudflareOptions(options: Record<string, unknown> = {}) {
  return {
    reviewer: { backend: "decision", decision: { provider: "cloudflare", ...options } },
  };
}

const accountId = "0123456789abcdef0123456789abcdef";

describe("parsePluginConfiguration", () => {
  it("uses the safe on-ask defaults", () => {
    expect(parsePluginConfiguration({ options: {}, env: {} })).toEqual({
      mode: "on-ask",
      reviewer: { backend: "agent", agent: {}, timeoutMs: 30_000, recordUsage: true },
    });
  });

  it("accepts an independent reviewer model", () => {
    expect(
      parsePluginConfiguration({
        options: {
          mode: "all-tools",
          reviewer: {
            agent: { model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" } },
            timeoutMs: 12_000,
          },
        },
      }),
    ).toEqual({
      mode: "all-tools",
      reviewer: {
        backend: "agent",
        agent: { model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" } },
        timeoutMs: 12_000,
        recordUsage: true,
      },
    });
  });

  it("rejects an unknown mode", () => {
    expect(() => parsePluginConfiguration({ options: { mode: "all" } })).toThrow(
      "Invalid auto-approval plugin options",
    );
  });

  describe("reviewer instructions", () => {
    it("accepts a single string", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { instructions: "  `pnpm test` is always safe.  " } },
          env: {},
        }).reviewer.instructions,
      ).toBe("`pnpm test` is always safe.");
    });

    it("joins a list into lines and drops blank entries", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              instructions: ["`pnpm test` is always safe.", " ", "Never allow `git push`."],
            },
          },
          env: {},
        }).reviewer.instructions,
      ).toBe("`pnpm test` is always safe.\nNever allow `git push`.");
    });

    it("leaves the option out when every entry is blank", () => {
      expect(
        parsePluginConfiguration({ options: { reviewer: { instructions: ["", " "] } }, env: {} })
          .reviewer,
      ).not.toHaveProperty("instructions");
    });

    it("rejects instructions that are not text", () => {
      expect(() =>
        parsePluginConfiguration({ options: { reviewer: { instructions: [1] } }, env: {} }),
      ).toThrow("Invalid auto-approval plugin options");
    });

    it("accepts instructions of exactly 4,000 characters, counting the line breaks", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { instructions: ["x".repeat(1_999), "y".repeat(2_000)] } },
          env: {},
        }).reviewer.instructions,
      ).toHaveLength(4_000);
    });

    it("rejects instructions longer than 4,000 characters", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { instructions: ["x".repeat(2_000), "y".repeat(2_000)] } },
          env: {},
        }),
      ).toThrow("reviewer.instructions must be at most 4000 characters");
    });
  });

  it("does not require decision model credentials for the opencode backend", () => {
    expect(
      parsePluginConfiguration({ options: { reviewer: { backend: "opencode" } }, env: {} })
        .reviewer,
    ).not.toHaveProperty("decision");
  });

  describe("decision backend with the typesafe provider", () => {
    it("reads the key and base URL from the environment with defaults", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions(),
          env: { TYPESAFE_API_KEY: "env-key" },
        }).reviewer.decision,
      ).toEqual({
        provider: "typesafe",
        apiKey: "env-key",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest",
        minAllowProbability: 0.6,
      });
    });

    it("prefers plugin options over the environment", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions({
            apiKey: "option-key",
            baseURL: "http://localhost:8787",
            model: "jev-1.13.0",
            minAllowProbability: 0.8,
          }),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://proxy.example" },
        }).reviewer.decision,
      ).toEqual({
        provider: "typesafe",
        apiKey: "option-key",
        endpoint: "http://localhost:8787/v1/systemone",
        model: "jev-1.13.0",
        minAllowProbability: 0.8,
      });
    });

    it("takes the base URL from the environment", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions(),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://proxy.example/" },
        }).reviewer.decision?.endpoint,
      ).toBe("https://proxy.example/v1/systemone");
    });

    it("never sends an option key to the environment's base URL", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions({ apiKey: "option-key" }),
          env: { TYPESAFE_BASE_URL: "https://attacker.example" },
        }).reviewer.decision?.endpoint,
      ).toBe("https://api.typesafe.ai/v1/systemone");
    });

    it("refuses an option base URL for the environment's key", () => {
      expect(() =>
        parsePluginConfiguration({
          options: typeSafeOptions({ baseURL: "https://attacker.example" }),
          env: { TYPESAFE_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.decision.baseURL needs reviewer.decision.apiKey");
    });

    it("trims whitespace around the key", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions(),
          env: { TYPESAFE_API_KEY: " env-key\n" },
        }).reviewer.decision?.apiKey,
      ).toBe("env-key");
    });

    it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
      "allows plain HTTP to the loopback origin %s",
      (baseURL) => {
        expect(
          parsePluginConfiguration({
            options: typeSafeOptions({ apiKey: "key", baseURL }),
            env: {},
          }).reviewer.decision?.endpoint,
        ).toBe(`${baseURL}/v1/systemone`);
      },
    );

    it("treats a blank option key as absent", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions({ apiKey: "  " }),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: " " },
        }).reviewer.decision,
      ).toMatchObject({ apiKey: "env-key", endpoint: "https://api.typesafe.ai/v1/systemone" });
      expect(() =>
        parsePluginConfiguration({
          options: typeSafeOptions({ apiKey: "  ", baseURL: "https://attacker.example" }),
          env: { TYPESAFE_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.decision.baseURL needs reviewer.decision.apiKey");
    });

    it("treats a blank base URL option as unset", () => {
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions({ apiKey: "key", baseURL: " " }),
          env: {},
        }).reviewer.decision?.endpoint,
      ).toBe("https://api.typesafe.ai/v1/systemone");
      expect(
        parsePluginConfiguration({
          options: typeSafeOptions({ baseURL: "" }),
          env: { TYPESAFE_API_KEY: "env-key" },
        }).reviewer.decision?.apiKey,
      ).toBe("env-key");
    });

    it("fails fast without an API key", () => {
      expect(() =>
        parsePluginConfiguration({ options: typeSafeOptions(), env: { TYPESAFE_API_KEY: "  " } }),
      ).toThrow("needs reviewer.decision.apiKey or TYPESAFE_API_KEY");
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
        parsePluginConfiguration({ options: typeSafeOptions({ apiKey: "key", baseURL }), env: {} }),
      ).toThrow("Invalid auto-approval plugin options");
    });

    it("rejects an out-of-range allow threshold", () => {
      expect(() =>
        parsePluginConfiguration({
          options: typeSafeOptions({ apiKey: "key", minAllowProbability: 1.5 }),
          env: {},
        }),
      ).toThrow("Invalid auto-approval plugin options");
    });
  });

  describe("decision backend with the cloudflare provider", () => {
    it("reads the token and account ID from wrangler's environment variables", () => {
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions(),
          env: { CLOUDFLARE_API_TOKEN: " cf-token\n", CLOUDFLARE_ACCOUNT_ID: accountId },
        }).reviewer.decision,
      ).toEqual({
        provider: "cloudflare",
        apiKey: "cf-token",
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`,
        model: "clef",
        minAllowProbability: 0.6,
      });
    });

    it("prefers plugin options over the environment", () => {
      const optionAccount = "fedcba9876543210fedcba9876543210";
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions({
            apiKey: "option-token",
            accountId: optionAccount,
            model: "clef-flash",
            minAllowProbability: 0.8,
          }),
          env: { CLOUDFLARE_API_TOKEN: "env-token", CLOUDFLARE_ACCOUNT_ID: accountId },
        }).reviewer.decision,
      ).toEqual({
        provider: "cloudflare",
        apiKey: "option-token",
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${optionAccount}/ai/run/@cf/cloudflare/clef-flash`,
        model: "clef-flash",
        minAllowProbability: 0.8,
      });
    });

    it("takes the account ID from the environment next to an option token", () => {
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "option-token" }),
          env: { CLOUDFLARE_ACCOUNT_ID: accountId },
        }).reviewer.decision?.endpoint,
      ).toContain(`/accounts/${accountId}/`);
    });

    it("fails fast without a token or an account ID", () => {
      expect(() =>
        parsePluginConfiguration({
          options: cloudflareOptions(),
          env: { CLOUDFLARE_ACCOUNT_ID: accountId },
        }),
      ).toThrow("needs reviewer.decision.apiKey or CLOUDFLARE_API_TOKEN");
      expect(() =>
        parsePluginConfiguration({
          options: cloudflareOptions(),
          env: { CLOUDFLARE_API_TOKEN: "cf-token" },
        }),
      ).toThrow("needs reviewer.decision.accountId or CLOUDFLARE_ACCOUNT_ID");
    });

    it("accepts an account ID in uppercase", () => {
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "key", accountId: accountId.toUpperCase() }),
          env: {},
        }).reviewer.decision?.endpoint,
      ).toContain(`/accounts/${accountId}/`);
    });

    it.each([
      ["a path segment", "../../zones"],
      ["a query", `${accountId}?x=1`],
      ["too few characters", "0123abcd"],
    ])("rejects an account ID with %s", (_label, id) => {
      expect(() =>
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "key", accountId: id }),
          env: {},
        }),
      ).toThrow("the Cloudflare account ID must be 32 hexadecimal characters");
    });

    it.each(["../clef", "clef/../../x", "@cf/cloudflare/clef", "clef?x=1", "Clef"])(
      "rejects the model name %s",
      (model) => {
        expect(() =>
          parsePluginConfiguration({
            options: cloudflareOptions({ apiKey: "key", accountId, model }),
            env: {},
          }),
        ).toThrow("the Cloudflare model must be a Workers AI model name");
      },
    );

    it("has no base URL option, so the token only reaches api.cloudflare.com", () => {
      expect(() =>
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "key", accountId, baseURL: "https://x.example" }),
          env: {},
        }),
      ).not.toThrow();
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "key", accountId, baseURL: "https://x.example" }),
          env: {},
        }).reviewer.decision?.endpoint,
      ).toMatch(/^https:\/\/api\.cloudflare\.com\//);
    });
  });

  describe("decision backend options", () => {
    it("needs a provider", () => {
      expect(() =>
        parsePluginConfiguration({ options: { reviewer: { backend: "decision" } }, env: {} }),
      ).toThrow("needs reviewer.decision with a provider");
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { backend: "decision", decision: { apiKey: "key" } } },
          env: { TYPESAFE_API_KEY: "key" },
        }),
      ).toThrow("Invalid auto-approval plugin options");
    });
  });

  describe("options of an unused backend", () => {
    it("starts the opencode backend whatever reviewer.decisionModel holds", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { decision: { model: "clef" }, decisionModel: 1, jev: "x" } },
          env: {},
        }).reviewer.backend,
      ).toBe("agent");
    });

    it("refuses reviewer.jev next to the decision-model backend", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "decision",
              decision: { provider: "typesafe", apiKey: "key" },
              jev: { baseURL: "https://proxy.example" },
            },
          },
          env: {},
        }),
      ).toThrow("reviewer.jev is only read with the deprecated reviewer.backend");
    });
  });

  describe("usage log", () => {
    it("records decision model usage by default", () => {
      expect(parsePluginConfiguration({ options: {}, env: {} }).reviewer.recordUsage).toBe(true);
    });

    it("can be turned off", () => {
      expect(
        parsePluginConfiguration({ options: { reviewer: { recordUsage: false } }, env: {} })
          .reviewer.recordUsage,
      ).toBe(false);
    });
  });

  describe("deprecated names", () => {
    it("reads backend opencode with reviewer.model as the agent backend", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "opencode",
              model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
            },
          },
          env: {},
        }).reviewer,
      ).toMatchObject({
        backend: "agent",
        agent: { model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" } },
      });
    });

    it("reads backend decision-model with reviewer.decisionModel as the decision backend", () => {
      const reviewer = parsePluginConfiguration({
        options: {
          reviewer: {
            backend: "decision-model",
            decisionModel: { provider: "cloudflare", apiKey: "key", accountId },
          },
        },
        env: {},
      }).reviewer;

      expect(reviewer.backend).toBe("decision");
      expect(reviewer.decision).toMatchObject({ provider: "cloudflare", model: "clef" });
    });

    it("names the deprecated key in its errors", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { backend: "decision-model", decisionModel: { provider: "cloudflare" } },
          },
          env: {},
        }),
      ).toThrow("needs reviewer.decisionModel.apiKey or CLOUDFLARE_API_TOKEN");
    });

    it("refuses a new key next to its deprecated name", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: { model: { providerID: "a", modelID: "b" } },
              model: { providerID: "c", modelID: "d" },
            },
          },
          env: {},
        }),
      ).toThrow("reviewer.model is the deprecated name of reviewer.agent.model");
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "decision",
              decision: { provider: "typesafe", apiKey: "key" },
              decisionModel: { provider: "typesafe", apiKey: "key" },
            },
          },
          env: {},
        }),
      ).toThrow("reviewer.decisionModel is the deprecated name of reviewer.decision");
    });
  });

  describe("deprecated jev backend", () => {
    it("still reads reviewer.jev as the typesafe provider", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "jev", jev: { apiKey: "option-key" } } },
          env: {},
        }).reviewer,
      ).toEqual({
        backend: "decision",
        agent: {},
        timeoutMs: 30_000,
        recordUsage: true,
        decision: {
          provider: "typesafe",
          apiKey: "option-key",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          model: "jev-latest",
          minAllowProbability: 0.6,
        },
      });
    });

    it("still reads TYPESAFE_API_KEY and keeps its error messages pointing at reviewer.jev", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "jev" } },
          env: { TYPESAFE_API_KEY: "env-key" },
        }).reviewer.decision?.apiKey,
      ).toBe("env-key");
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { backend: "jev", jev: { baseURL: "https://attacker.example" } } },
          env: { TYPESAFE_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.jev.baseURL needs reviewer.jev.apiKey");
    });

    it("refuses reviewer.decisionModel next to backend jev", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { backend: "jev", decision: { provider: "cloudflare", apiKey: "key" } },
          },
          env: {},
        }),
      ).toThrow('the deprecated reviewer.backend "jev" reads reviewer.jev only');
    });
  });
});
