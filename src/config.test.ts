import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePluginConfiguration, usesAgentReviewer } from "./config.js";

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

function typeSafeOptionsWithEnv(options: Record<string, unknown>) {
  return { options: typeSafeOptions({ apiKey: "k", ...options }), env: {} };
}

describe("parsePluginConfiguration", () => {
  it("requires an explicit absolute audit path and accepts conversation privacy controls", () => {
    expect(() => parsePluginConfiguration({ options: { auditLog: { enabled: true } } })).toThrow(
      "absolute path",
    );
    expect(() =>
      parsePluginConfiguration({ options: { auditLog: { path: "audit.jsonl" } } }),
    ).toThrow("Invalid auto-approval");
    const path = join(process.cwd(), "tmp", "audit.jsonl");
    const config = parsePluginConfiguration({
      options: {
        auditLog: { enabled: true, path, includeCommand: true },
        conversation: { enabled: false, includeAssistant: true },
      },
      env: { OPENCODE_DATA_DIR: "ignored", XDG_DATA_HOME: "ignored" },
    });
    expect(config.auditLog).toEqual({ enabled: true, path, includeCommand: true });
    expect(config.conversation).toEqual({ enabled: false, includeAssistant: true });
  });
  it("uses the safe on-ask defaults", () => {
    expect(parsePluginConfiguration({ options: {}, env: {} })).toEqual({
      mode: "on-ask",
      allToolsNativeAsks: "preserve",
      auditLog: { enabled: false, includeCommand: false },
      conversation: { enabled: false, includeAssistant: false },
      reviewer: {
        backend: "agent",
        agent: { runtime: "opencode", maxInputBytes: 200_000, cleanupSessions: false },
        timeoutMs: 30_000,
        recordUsage: true,
      },
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
      allToolsNativeAsks: "preserve",
      auditLog: { enabled: false, includeCommand: false },
      conversation: { enabled: false, includeAssistant: false },
      reviewer: {
        backend: "agent",
        agent: {
          runtime: "opencode",
          model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
          maxInputBytes: 200_000,
          cleanupSessions: false,
        },
        timeoutMs: 12_000,
        recordUsage: true,
      },
    });
  });

  it("requires explicit opt-in to review native asks in all-tools V2", () => {
    expect(
      parsePluginConfiguration({
        options: { mode: "all-tools", allToolsNativeAsks: "review" },
      }).allToolsNativeAsks,
    ).toBe("review");
    expect(() => parsePluginConfiguration({ options: { allToolsNativeAsks: "invalid" } })).toThrow(
      "Invalid auto-approval plugin options",
    );
  });

  it("only enables reviewer cleanup on explicit V2 OpenCode opt-in", () => {
    expect(
      parsePluginConfiguration({
        options: { reviewer: { agent: { cleanupSessions: true } } },
      }).reviewer.agent,
    ).toMatchObject({
      runtime: "opencode",
      cleanupSessions: true,
    });
    expect(() =>
      parsePluginConfiguration({
        options: {
          reviewer: {
            agent: {
              runtime: "codex-sdk",
              cleanupSessions: true,
            },
          },
        },
      }),
    ).toThrow('reviewer.agent.cleanupSessions requires reviewer.agent.runtime "opencode".');
  });

  describe("agent runtime", () => {
    it("runs the agent reviewer on the Claude Agent SDK with a Claude model name", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: {
                runtime: "claude-agent-sdk",
                model: "claude-sonnet-5-5",
                claudeAgentSdk: { path: "/opt/sdk/node_modules/@anthropic-ai/claude-agent-sdk" },
              },
            },
          },
          env: {},
        }).reviewer.agent,
      ).toEqual({
        runtime: "claude-agent-sdk",
        model: "claude-sonnet-5-5",
        sdkPath: "/opt/sdk/node_modules/@anthropic-ai/claude-agent-sdk",
        maxInputBytes: 200_000,
      });
    });

    it("leaves the Claude model and the SDK path unset by default", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { agent: { runtime: "claude-agent-sdk" } } },
          env: {},
        }).reviewer.agent,
      ).toEqual({ runtime: "claude-agent-sdk", maxInputBytes: 200_000 });
    });

    it("needs no OpenCode reviewer agent on the Claude Agent SDK", () => {
      expect(
        usesAgentReviewer(
          parsePluginConfiguration({
            options: { reviewer: { agent: { runtime: "claude-agent-sdk" } } },
            env: {},
          }),
        ),
      ).toBe(false);
      expect(
        usesAgentReviewer(
          parsePluginConfiguration({
            options: {
              reviewer: {
                backend: "decision",
                agent: { runtime: "claude-agent-sdk" },
                decision: { provider: "typesafe", apiKey: "k", onOversize: "agent" },
              },
            },
            env: {},
          }),
        ),
      ).toBe(false);
      expect(usesAgentReviewer(parsePluginConfiguration({ options: {}, env: {} }))).toBe(true);
    });

    it("refuses an OpenCode model reference on the Claude Agent SDK", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: {
                runtime: "claude-agent-sdk",
                model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" },
              },
            },
          },
          env: {},
        }),
      ).toThrow('with the "claude-agent-sdk" runtime, reviewer.agent.model must be a model name');
    });

    it("refuses a bare model name on the OpenCode runtime", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { agent: { model: "claude-sonnet-5-5" } } },
          env: {},
        }),
      ).toThrow(
        'with the "opencode" runtime, reviewer.agent.model must be { providerID, modelID }',
      );
    });

    it("refuses Claude Agent SDK options on the OpenCode runtime", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { agent: { claudeAgentSdk: { path: "/opt/sdk" } } } },
          env: {},
        }),
      ).toThrow('reviewer.agent.claudeAgentSdk needs reviewer.agent.runtime "claude-agent-sdk"');
    });

    it("runs the agent reviewer on the Codex SDK", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: {
                runtime: "codex-sdk",
                model: "gpt-5.6-codex",
                codexSdk: { path: "/opt/sdk/node_modules/@openai/codex-sdk" },
              },
            },
          },
          env: {},
        }).reviewer.agent,
      ).toEqual({
        runtime: "codex-sdk",
        model: "gpt-5.6-codex",
        sdkPath: "/opt/sdk/node_modules/@openai/codex-sdk",
        maxInputBytes: 200_000,
      });
    });

    it("refuses another runtime's SDK options", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: { runtime: "codex-sdk", claudeAgentSdk: { path: "/opt/sdk" } },
            },
          },
          env: {},
        }),
      ).toThrow('reviewer.agent.claudeAgentSdk needs reviewer.agent.runtime "claude-agent-sdk"');
    });

    it("refuses a relative SDK path", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              agent: { runtime: "claude-agent-sdk", claudeAgentSdk: { path: "node_modules/sdk" } },
            },
          },
          env: {},
        }),
      ).toThrow("Invalid auto-approval plugin options");
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

    it("accepts longer instructions up to a raised maxInstructionsChars", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: { instructions: "x".repeat(10_000), maxInstructionsChars: 10_000 },
          },
          env: {},
        }).reviewer.instructions,
      ).toHaveLength(10_000);
    });

    it("rejects instructions longer than a raised maxInstructionsChars", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { instructions: "x".repeat(10_001), maxInstructionsChars: 10_000 },
          },
          env: {},
        }),
      ).toThrow("reviewer.instructions must be at most 10000 characters");
    });

    it.each([3_999, 200_001, 5_000.5])("rejects maxInstructionsChars of %s", (value) => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { maxInstructionsChars: value } },
          env: {},
        }),
      ).toThrow("Invalid auto-approval plugin options");
    });

    it("accepts maxInstructionsChars at the ceiling", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              instructions: "x".repeat(200_000),
              maxInstructionsChars: 200_000,
              agent: { maxInputBytes: 400_000 },
            },
          },
          env: {},
        }).reviewer.instructions,
      ).toHaveLength(200_000);
    });

    it("accepts maxInstructionsChars at the default without instructions", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { maxInstructionsChars: 4_000 } },
          env: {},
        }).reviewer,
      ).not.toHaveProperty("instructions");
    });

    it("suggests maxInstructionsChars only below its ceiling", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { instructions: "x".repeat(4_001) } },
          env: {},
        }),
      ).toThrow("raise reviewer.maxInstructionsChars (up to 200000) to allow more.");
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { instructions: "x".repeat(200_001), maxInstructionsChars: 200_000 },
          },
          env: {},
        }),
      ).toThrow(/must be at most 200000 characters\.$/);
    });

    it("rejects instructions that fill the agent reviewer's maxInputBytes", () => {
      // 70,000 Japanese characters are 210,000 UTF-8 bytes.
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { instructions: "日".repeat(70_000), maxInstructionsChars: 70_000 },
          },
          env: {},
        }),
      ).toThrow(
        "reviewer.instructions (210,000 bytes) leave no room for the operation within reviewer.agent.maxInputBytes (200,000)",
      );
    });

    it("rejects instructions that fill the chat reviewer's maxInputBytes", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "chat",
              instructions: "x".repeat(5_000),
              maxInstructionsChars: 5_000,
              chat: { apiKey: "test-key", model: "test-model", maxInputBytes: 5_000 },
            },
          },
          env: {},
        }),
      ).toThrow("within reviewer.chat.maxInputBytes (5,000)");
    });

    it("rejects instructions that fill the decision model's budget", () => {
      const env = { TYPESAFE_API_KEY: "test-key" };
      // About 32,000 tokens.
      const reviewer = {
        backend: "decision",
        instructions: "x".repeat(80_000),
        maxInstructionsChars: 80_000,
      };
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { ...reviewer, decision: { provider: "typesafe" } } },
          env,
        }),
      ).toThrow("within reviewer.decision.maxStateTokens (28,000)");
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: { ...reviewer, decision: { provider: "typesafe", longContext: true } },
          },
          env,
        }).reviewer.instructions,
      ).toHaveLength(80_000);
    });
  });

  it("does not require decision model credentials for the agent backend", () => {
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
        maxStateTokens: 28_000,
        onOversize: "escalate",
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
            maxStateTokens: 28_000,
            onOversize: "escalate",
          }),
          env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://proxy.example" },
        }).reviewer.decision,
      ).toEqual({
        provider: "typesafe",
        apiKey: "option-key",
        endpoint: "http://localhost:8787/v1/systemone",
        model: "jev-1.13.0",
        minAllowProbability: 0.8,
        maxStateTokens: 28_000,
        onOversize: "escalate",
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
        maxStateTokens: 20_000,
        onOversize: "escalate",
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
            maxStateTokens: 20_000,
            onOversize: "escalate",
          }),
          env: { CLOUDFLARE_API_TOKEN: "env-token", CLOUDFLARE_ACCOUNT_ID: accountId },
        }).reviewer.decision,
      ).toEqual({
        provider: "cloudflare",
        apiKey: "option-token",
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${optionAccount}/ai/run/@cf/cloudflare/clef-flash`,
        model: "clef-flash",
        minAllowProbability: 0.8,
        maxStateTokens: 20_000,
        onOversize: "escalate",
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
    it("starts the agent backend whatever the decision options hold", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { decision: { model: "clef" }, jev: "x" } },
          env: {},
        }).reviewer.backend,
      ).toBe("agent");
    });

    it("refuses reviewer.jev next to the decision backend", () => {
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

  describe("chat backend", () => {
    it("reads the model with the key and base URL from the options", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "chat",
              chat: {
                baseURL: "https://openrouter.ai/api/v1/",
                apiKey: " or-key ",
                model: "openai/gpt-5.6-luna",
              },
            },
          },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "env-key" },
        }).reviewer,
      ).toMatchObject({
        backend: "chat",
        chat: {
          apiKey: "or-key",
          endpoint: "https://openrouter.ai/api/v1/chat/completions",
          model: "openai/gpt-5.6-luna",
          maxInputBytes: 200_000,
        },
      });
    });

    it("reads the key and base URL from the environment, OpenAI by default", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { model: "gpt-5.6" } } },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "env-key" },
        }).reviewer.chat,
      ).toMatchObject({
        apiKey: "env-key",
        endpoint: "https://api.openai.com/v1/chat/completions",
      });
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { model: "m" } } },
          env: {
            AUTO_APPROVAL_CHAT_API_KEY: "env-key",
            AUTO_APPROVAL_CHAT_BASE_URL: "http://localhost:11434/v1",
          },
        }).reviewer.chat?.endpoint,
      ).toBe("http://localhost:11434/v1/chat/completions");
    });

    it.each([
      ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1/chat/completions"],
      ["anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/messages"],
    ])("calls the %s API on its fixed host with %s", (provider, keyVariable, endpoint) => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { provider, model: "m" } } },
          env: { [keyVariable]: " vendor-key ", AUTO_APPROVAL_CHAT_API_KEY: "generic-key" },
        }).reviewer.chat,
      ).toEqual({
        provider,
        apiKey: "vendor-key",
        endpoint,
        model: "m",
        maxInputBytes: 200_000,
      });
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: { backend: "chat", chat: { provider, apiKey: "option-key", model: "m" } },
          },
          env: { [keyVariable]: "vendor-key" },
        }).reviewer.chat?.apiKey,
      ).toBe("option-key");
    });

    it("never sends a vendor key anywhere but the vendor's own host", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "chat",
              chat: {
                provider: "anthropic",
                apiKey: "k",
                baseURL: "https://attacker.example/v1",
                model: "m",
              },
            },
          },
          env: {},
        }),
      ).toThrow("reviewer.chat.baseURL is not used with the anthropic provider");
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { provider: "openai", model: "m" } } },
          env: { OPENAI_API_KEY: "k", AUTO_APPROVAL_CHAT_BASE_URL: "https://attacker.example/v1" },
        }).reviewer.chat?.endpoint,
      ).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("treats a blank baseURL as unset for a vendor provider", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "chat",
              chat: { provider: "anthropic", baseURL: " ", model: "m" },
            },
          },
          env: { ANTHROPIC_API_KEY: "k" },
        }).reviewer.chat?.endpoint,
      ).toBe("https://api.anthropic.com/v1/messages");
    });

    it("refuses an unknown provider", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { provider: "azure", model: "m" } } },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "k" },
        }),
      ).toThrow("Invalid auto-approval plugin options: reviewer.chat");
    });

    it("resolves a vendor provider for the decision backend's chat fallback", () => {
      expect(
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "decision",
              decision: { provider: "typesafe", apiKey: "t", onOversize: "chat" },
              chat: { provider: "anthropic", model: "claude-haiku-5-5" },
            },
          },
          env: { ANTHROPIC_API_KEY: "ant-key" },
        }).reviewer.chat,
      ).toMatchObject({
        provider: "anthropic",
        apiKey: "ant-key",
        endpoint: "https://api.anthropic.com/v1/messages",
      });
    });

    it("names the vendor's key variable when the key is missing", () => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { provider: "anthropic", model: "m" } } },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "generic-key" },
        }),
      ).toThrow("the anthropic provider needs reviewer.chat.apiKey or ANTHROPIC_API_KEY");
    });

    it("keeps OpenAI-compatible endpoints the default provider", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { model: "m" } } },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "k", OPENAI_API_KEY: "openai-key" },
        }).reviewer.chat,
      ).toMatchObject({ provider: "openai-compatible", apiKey: "k" });
    });

    it("never sends an option key to the environment's base URL, nor the reverse", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", chat: { apiKey: "k", model: "m" } } },
          env: { AUTO_APPROVAL_CHAT_BASE_URL: "https://attacker.example/v1" },
        }).reviewer.chat?.endpoint,
      ).toBe("https://api.openai.com/v1/chat/completions");
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "chat",
              chat: { baseURL: "https://attacker.example", model: "m" },
            },
          },
          env: { AUTO_APPROVAL_CHAT_API_KEY: "env-key" },
        }),
      ).toThrow("reviewer.chat.baseURL needs reviewer.chat.apiKey");
    });

    it.each([
      ["no reviewer.chat", {}, "needs reviewer.chat with a model"],
      ["no model", { chat: { apiKey: "k" } }, "reviewer.chat"],
      [
        "no key",
        { chat: { model: "m" } },
        "needs reviewer.chat.apiKey or AUTO_APPROVAL_CHAT_API_KEY",
      ],
      [
        "plain HTTP to a remote host",
        { chat: { apiKey: "k", model: "m", baseURL: "http://x.example/v1" } },
        "must use HTTPS",
      ],
      [
        "a query",
        { chat: { apiKey: "k", model: "m", baseURL: "https://x.example/v1?a=1" } },
        "must not carry",
      ],
      [
        "credentials",
        { chat: { apiKey: "k", model: "m", baseURL: `https://u:${"x"}@x.example/v1` } },
        "must not carry",
      ],
    ])("fails at startup with %s", (_label, options, message) => {
      expect(() =>
        parsePluginConfiguration({
          options: { reviewer: { backend: "chat", ...options } },
          env: {},
        }),
      ).toThrow(message);
    });
  });

  describe("decision onOversize", () => {
    it("escalates by default and needs no other backend", () => {
      expect(parsePluginConfiguration(typeSafeOptionsWithEnv({})).reviewer).not.toHaveProperty(
        "chat",
      );
    });

    it("reads reviewer.chat when the fallback is chat", () => {
      const reviewer = parsePluginConfiguration({
        options: {
          reviewer: {
            backend: "decision",
            decision: { provider: "typesafe", apiKey: "k", onOversize: "chat" },
            chat: { apiKey: "or-key", baseURL: "https://openrouter.ai/api/v1", model: "m" },
          },
        },
        env: {},
      }).reviewer;

      expect(reviewer.decision?.onOversize).toBe("chat");
      expect(reviewer.chat?.model).toBe("m");
    });

    it("fails at startup when the chat fallback is not configured", () => {
      expect(() =>
        parsePluginConfiguration(typeSafeOptionsWithEnv({ onOversize: "chat" })),
      ).toThrow("needs reviewer.chat with a model");
    });

    it("rejects an unknown fallback and an out-of-range budget", () => {
      expect(() =>
        parsePluginConfiguration(typeSafeOptionsWithEnv({ onOversize: "human" })),
      ).toThrow("reviewer.decision");
      expect(() =>
        parsePluginConfiguration(typeSafeOptionsWithEnv({ maxStateTokens: 100_000 })),
      ).toThrow("reviewer.decision");
    });
  });

  describe("decision longContext", () => {
    it("is off by default", () => {
      expect(
        parsePluginConfiguration(typeSafeOptionsWithEnv({})).reviewer.decision,
      ).not.toHaveProperty("longContext");
      expect(
        parsePluginConfiguration(typeSafeOptionsWithEnv({ longContext: false })).reviewer.decision,
      ).not.toHaveProperty("longContext");
    });

    it("takes true or {} with the defaults and a stricter allow threshold", () => {
      for (const longContext of [true, {}]) {
        expect(
          parsePluginConfiguration(typeSafeOptionsWithEnv({ longContext })).reviewer.decision
            ?.longContext,
        ).toEqual({ maxStateTokens: 240_000, minAllowProbability: 0.8 });
      }
      expect(
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({ longContext: true, minAllowProbability: 0.9 }),
        ).reviewer.decision?.longContext,
      ).toEqual({ maxStateTokens: 240_000, minAllowProbability: 0.9 });
    });

    it("rejects a long-context threshold below the regular one", () => {
      expect(() =>
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({
            minAllowProbability: 0.7,
            longContext: { minAllowProbability: 0.6 },
          }),
        ),
      ).toThrow("longContext.minAllowProbability must not be below");
      expect(
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({
            minAllowProbability: 0.7,
            longContext: { minAllowProbability: 0.7 },
          }),
        ).reviewer.decision?.longContext?.minAllowProbability,
      ).toBe(0.7);
    });

    it("reads its own budget and threshold", () => {
      expect(
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({
            longContext: { maxStateTokens: 100_000, minAllowProbability: 0.85 },
          }),
        ).reviewer.decision?.longContext,
      ).toEqual({ maxStateTokens: 100_000, minAllowProbability: 0.85 });
    });

    it("rejects a budget out of range or not above the regular one", () => {
      expect(() =>
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({ longContext: { maxStateTokens: 300_000 } }),
        ),
      ).toThrow("reviewer.decision");
      expect(() =>
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({
            maxStateTokens: 30_000,
            longContext: { maxStateTokens: 30_000 },
          }),
        ),
      ).toThrow("reviewer.decision.longContext.maxStateTokens must be larger than");
    });

    it("accepts the largest budget", () => {
      expect(
        parsePluginConfiguration(
          typeSafeOptionsWithEnv({ longContext: { maxStateTokens: 256_000 } }),
        ).reviewer.decision?.longContext?.maxStateTokens,
      ).toBe(256_000);
    });

    it("is refused for the cloudflare provider unless false", () => {
      expect(
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "t", accountId, longContext: false }),
          env: {},
        }).reviewer.decision,
      ).not.toHaveProperty("longContext");
      expect(() =>
        parsePluginConfiguration({
          options: cloudflareOptions({ apiKey: "t", accountId, longContext: true }),
          env: {},
        }),
      ).toThrow("longContext is only available with the typesafe provider");
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
  });

  describe("mixing a name with its deprecated form", () => {
    it.each(["agent", "decision"])(
      "refuses reviewer.agent.model with reviewer.model under the %s backend",
      (backend) => {
        expect(() =>
          parsePluginConfiguration({
            options: {
              reviewer: {
                backend,
                agent: { model: { providerID: "a", modelID: "b" } },
                model: { providerID: "c", modelID: "d" },
                decision: { provider: "typesafe", apiKey: "k" },
              },
            },
            env: {},
          }),
        ).toThrow("reviewer.model is the deprecated name of reviewer.agent.model");
      },
    );

    it("accepts an empty reviewer.agent next to reviewer.model", () => {
      expect(
        parsePluginConfiguration({
          options: { reviewer: { agent: {}, model: { providerID: "c", modelID: "d" } } },
          env: {},
        }).reviewer.agent,
      ).toEqual({
        runtime: "opencode",
        model: { providerID: "c", modelID: "d" },
        maxInputBytes: 200_000,
        cleanupSessions: false,
      });
    });

    it.each(["agent", "decision"])(
      "refuses reviewer.decision with reviewer.decisionModel under the %s backend",
      (backend) => {
        expect(() =>
          parsePluginConfiguration({
            options: {
              reviewer: {
                backend,
                decision: { provider: "typesafe", apiKey: "k" },
                decisionModel: { provider: "typesafe", apiKey: "k" },
              },
            },
            env: {},
          }),
        ).toThrow("reviewer.decisionModel is the deprecated name of reviewer.decision");
      },
    );

    it.each([
      ["decision", { decisionModel: { provider: "typesafe", apiKey: "k" } }, "decision"],
      ["agent", { model: { providerID: "a", modelID: "b" } }, "agent"],
      ["opencode", { agent: { model: { providerID: "a", modelID: "b" } } }, "agent"],
    ])("accepts backend %s with options under the other naming", (backend, options, expected) => {
      expect(
        parsePluginConfiguration({ options: { reviewer: { backend, ...options } }, env: {} })
          .reviewer.backend,
      ).toBe(expected);
    });

    it("names reviewer.decisionModel in a typesafe error", () => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: {
              backend: "decision-model",
              decisionModel: { provider: "typesafe", baseURL: "https://proxy.example" },
            },
          },
          env: { TYPESAFE_API_KEY: "k" },
        }),
      ).toThrow("reviewer.decisionModel.baseURL needs reviewer.decisionModel.apiKey");
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
        agent: { runtime: "opencode", maxInputBytes: 200_000, cleanupSessions: false },
        timeoutMs: 30_000,
        recordUsage: true,
        decision: {
          provider: "typesafe",
          apiKey: "option-key",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          model: "jev-latest",
          minAllowProbability: 0.6,
          maxStateTokens: 28_000,
          onOversize: "escalate",
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

    it.each(["decision", "decisionModel"])("refuses reviewer.%s next to backend jev", (key) => {
      expect(() =>
        parsePluginConfiguration({
          options: {
            reviewer: { backend: "jev", [key]: { provider: "cloudflare", apiKey: "key" } },
          },
          env: {},
        }),
      ).toThrow('the deprecated reviewer.backend "jev" reads reviewer.jev only');
    });
  });
});
