import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePluginConfiguration, resolveJevEndpoint } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("parsePluginConfiguration", () => {
  it("uses the safe on-ask defaults", () => {
    expect(parsePluginConfiguration({})).toEqual({
      mode: "on-ask",
      reviewer: { backend: "opencode", timeoutMs: 30_000 },
    });
  });

  it("accepts an independent reviewer model", () => {
    expect(
      parsePluginConfiguration({
        mode: "all-tools",
        reviewer: {
          model: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
          timeoutMs: 12_000,
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
    expect(() => parsePluginConfiguration({ mode: "all" })).toThrow(
      "Invalid auto-approval plugin options",
    );
  });

  it("resolves Jev defaults and trims the configured key", () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "");
    expect(
      parsePluginConfiguration({ reviewer: { backend: "jev", jev: { apiKey: " YOUR_API_KEY " } } })
        .reviewer,
    ).toEqual({
      backend: "jev",
      timeoutMs: 30_000,
      jev: {
        apiKey: "YOUR_API_KEY",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-1.13.0",
      },
    });
  });

  it("uses environment fallbacks and gives file options precedence", () => {
    vi.stubEnv("TYPESAFE_API_KEY", " ENV_PLACEHOLDER ");
    vi.stubEnv("TYPESAFE_BASE_URL", " http://localhost:8080/proxy/// ");
    expect(parsePluginConfiguration({ reviewer: { backend: "jev" } }).reviewer).toMatchObject({
      jev: { apiKey: "ENV_PLACEHOLDER", endpoint: "http://localhost:8080/proxy/v1/systemone" },
    });
    expect(
      parsePluginConfiguration({
        reviewer: {
          backend: "jev",
          jev: { apiKey: "YOUR_API_KEY", baseURL: "https://example.com", model: "jev-latest" },
        },
      }).reviewer,
    ).toMatchObject({
      jev: {
        apiKey: "YOUR_API_KEY",
        endpoint: "https://example.com/v1/systemone",
        model: "jev-latest",
      },
    });
  });

  it("fails during configuration parsing for missing keys or invalid endpoints", () => {
    vi.stubEnv("TYPESAFE_API_KEY", " ");
    expect(() => parsePluginConfiguration({ reviewer: { backend: "jev" } })).toThrow(
      "Jev requires",
    );
    expect(() =>
      parsePluginConfiguration({
        reviewer: { backend: "jev", jev: { apiKey: "YOUR_API_KEY", baseURL: "invalid" } },
      }),
    ).toThrow("Invalid Jev baseURL");
    expect(() => parsePluginConfiguration({ reviewer: { backend: "invalid" } })).toThrow(
      "Invalid auto-approval",
    );
  });

  it.each([undefined, "", "invalid"])("ignores unused Jev environment and options: %s", (value) => {
    vi.stubEnv("TYPESAFE_API_KEY", value);
    vi.stubEnv("TYPESAFE_BASE_URL", value);
    expect(
      parsePluginConfiguration({ reviewer: { jev: { apiKey: 123, baseURL: "invalid" } } }).reviewer,
    ).toEqual({ backend: "opencode", timeoutMs: 30_000 });
  });

  it.each([
    "invalid",
    "ftp://example.com",
    "https://example.com?",
    "https://example.com#",
    "https://example.com?a=b",
    "https://example.com/#fragment",
    "https://example.com/prefix/v1/systemone///",
  ])("rejects invalid base URL %s", (url) => {
    expect(() => resolveJevEndpoint(url)).toThrow("Invalid Jev baseURL");
  });

  it("rejects URL credentials", () => {
    const url = new URL("https://example.com");
    url.username = "YOUR_API_KEY";
    url.password = "YOUR_API_KEY";
    expect(() => resolveJevEndpoint(url.toString())).toThrow("Invalid Jev baseURL");
  });

  it.each(["", "   ", 123])("rejects invalid Jev keys without echoing values", (apiKey) => {
    expect(() =>
      parsePluginConfiguration({ reviewer: { backend: "jev", jev: { apiKey } } }),
    ).toThrow("invalid Jev configuration");
  });
});
