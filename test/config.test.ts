import { describe, it, expect, vi } from "vitest";
import { config } from "../src/config.js";

describe("config.req", () => {
  it("throws naming the missing env var", () => {
    vi.stubEnv("TRELLO_API_KEY", undefined);
    expect(() => config.trello.apiKey()).toThrow(/Missing required env var: TRELLO_API_KEY/);
  });

  it("treats an empty env var as missing", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    expect(() => config.discord.botToken()).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("returns the value when set", () => {
    vi.stubEnv("REPO_PATH", "/srv/repos/app");
    expect(config.factory.repoPath()).toBe("/srv/repos/app");
  });
});

describe("config.factory defaults", () => {
  it("defaults webhookPort to 8787", () => {
    vi.stubEnv("WEBHOOK_PORT", undefined);
    expect(config.factory.webhookPort).toBe(8787);
  });

  it("reads an override for webhookPort", () => {
    vi.stubEnv("WEBHOOK_PORT", "9000");
    expect(config.factory.webhookPort).toBe(9000);
  });

  it("defaults ciTimeoutMs to 15 minutes", () => {
    vi.stubEnv("CI_TIMEOUT_MS", undefined);
    expect(config.factory.ciTimeoutMs).toBe(15 * 60_000);
  });

  it("falls back to the default instead of NaN/0 for empty or junk numbers", () => {
    vi.stubEnv("CI_TIMEOUT_MS", "");
    expect(config.factory.ciTimeoutMs).toBe(15 * 60_000);

    vi.stubEnv("CI_TIMEOUT_MS", "soon");
    expect(config.factory.ciTimeoutMs).toBe(15 * 60_000);

    vi.stubEnv("WEBHOOK_PORT", "");
    expect(config.factory.webhookPort).toBe(8787);
  });

  it("has empty webhook secrets by default", () => {
    vi.stubEnv("WEBHOOK_SECRET", undefined);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", undefined);
    expect(config.factory.webhookSecret).toBe("");
    expect(config.github.webhookSecret()).toBe("");
  });

  it("picks up secrets when they are set", () => {
    vi.stubEnv("WEBHOOK_SECRET", "s3cret");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "ghsecret");
    expect(config.factory.webhookSecret).toBe("s3cret");
    expect(config.github.webhookSecret()).toBe("ghsecret");
  });

  it("is read at call time, not at import time", () => {
    vi.stubEnv("WEBHOOK_PORT", "1234");
    expect(config.factory.webhookPort).toBe(1234);
    vi.stubEnv("WEBHOOK_PORT", "4321");
    expect(config.factory.webhookPort).toBe(4321);
  });
});
