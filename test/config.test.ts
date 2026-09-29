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

/**
 * Phase 2.3's knobs. Each of these is a spend limit or a model choice, and every
 * one of them fails silently when misread: `NaN` becomes a cap that refuses
 * nothing, and a fallback that reads the wrong variable makes the reviewer cost
 * what the coder costs.
 */
describe("config.factory review knobs", () => {
  it("defaults REVIEW_MAX_COMMENTS to 20 and reads an override", () => {
    vi.stubEnv("REVIEW_MAX_COMMENTS", undefined);
    expect(config.factory.reviewMaxComments).toBe(20);
    vi.stubEnv("REVIEW_MAX_COMMENTS", "3");
    expect(config.factory.reviewMaxComments).toBe(3);
  });

  it("never lets a comment cap go negative, which would refuse every review", () => {
    vi.stubEnv("REVIEW_MAX_COMMENTS", "-5");
    expect(config.factory.reviewMaxComments).toBe(0);
  });

  it("defaults the per-card review budget to 5, and treats 0 as off rather than unbounded", () => {
    vi.stubEnv("REVIEW_MAX_RUNS_PER_CARD", undefined);
    expect(config.factory.reviewMaxRunsPerCard).toBe(5);
    vi.stubEnv("REVIEW_MAX_RUNS_PER_CARD", "0");
    expect(config.factory.reviewMaxRunsPerCard).toBe(0);
  });

  it("falls back to AGENT_TIMEOUT_MS for the review wall clock", () => {
    vi.stubEnv("REVIEW_TIMEOUT_MS", undefined);
    vi.stubEnv("AGENT_TIMEOUT_MS", "123456");
    expect(config.factory.reviewTimeoutMs).toBe(123456);
    vi.stubEnv("REVIEW_TIMEOUT_MS", "60000");
    expect(config.factory.reviewTimeoutMs).toBe(60000);
  });

  /**
   * The whole reason `REVIEWER_MODEL` exists is to let a cheap model do reviews. If
   * the fallback were reversed — AGENT_MODEL consulted first — setting a cheap
   * reviewer would appear to work and silently keep the coder's model.
   */
  it("prefers REVIEWER_MODEL and falls back to AGENT_MODEL", () => {
    vi.stubEnv("REVIEWER_MODEL", "vmlx/cheap-model");
    vi.stubEnv("AGENT_MODEL", "anthropic/claude-opus");
    expect(config.factory.reviewerModel).toBe("vmlx/cheap-model");

    vi.stubEnv("REVIEWER_MODEL", "");
    expect(config.factory.reviewerModel).toBe("anthropic/claude-opus");

    vi.stubEnv("AGENT_MODEL", undefined);
    expect(config.factory.reviewerModel).toBe("");
  });

  it("adds no --add-host mapping unless the deployment asks for one", () => {
    // Empty is the safe default and the one Docker Desktop needs; the Linux deploy
    // script writes the mapping explicitly. A non-empty default would override
    // Desktop's built-in name, which is the arrangement the smoke tests pass with.
    vi.stubEnv("FACTORY_IPC_ADD_HOST", undefined);
    expect(config.factory.ipcAddHost).toBe("");
    vi.stubEnv("FACTORY_IPC_ADD_HOST", "host.docker.internal:host-gateway");
    expect(config.factory.ipcAddHost).toBe("host.docker.internal:host-gateway");
  });
});
