import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AGENT_CONTAINER_HOME,
  AGENT_CONTAINER_PATH,
  FACTORY_SECRET_ENV_KEYS,
  PROVIDER_ENV_KEYS,
  buildAgentEnv,
} from "../../src/agent/env.js";

/** Distinct sentinel per secret so a leak names itself in the failure output. */
const SECRET_VALUES = Object.fromEntries(
  FACTORY_SECRET_ENV_KEYS.map((name, i) => [name, `leak-${i}-${name.toLowerCase()}`])
);

beforeEach(() => {
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    vi.stubEnv(name, value);
  }
  // the host's own PATH/HOME must not be what the container gets
  vi.stubEnv("PATH", "/Users/orchestrator/.local/bin:/usr/bin");
  vi.stubEnv("HOME", "/Users/orchestrator");
  vi.stubEnv("SHELL", "/bin/zsh");
  vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "leak-aws");
});

describe("buildAgentEnv", () => {
  it("carries a container-side PATH and HOME", () => {
    const env = buildAgentEnv({});

    expect(env.PATH).toBe(AGENT_CONTAINER_PATH);
    expect(env.HOME).toBe(AGENT_CONTAINER_HOME);
  });

  it("never inherits the orchestrator's own PATH or HOME", () => {
    const env = buildAgentEnv(process.env);

    expect(env.HOME).not.toBe("/Users/orchestrator");
    expect(env.PATH).not.toContain("orchestrator");
  });

  it("passes through a provider key that is set", () => {
    const env = buildAgentEnv({ ANTHROPIC_API_KEY: "sk-ant-real" });

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
  });

  it("omits provider keys that are unset or blank", () => {
    const env = buildAgentEnv({
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "   ",
      ANTHROPIC_API_KEY: "sk-ant",
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("is exactly PATH, HOME and the provider keys that are set", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "a",
      GROQ_API_KEY: "g",
      GITHUB_TOKEN: SECRET_VALUES.GITHUB_TOKEN,
    });

    expect(Object.keys(env).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "GROQ_API_KEY", "HOME", "PATH"].sort()
    );
  });

  // The whole point of phase 2.1: these names are set in the orchestrator and
  // must never reach an agent, whatever else gets added to the env builder.
  it("excludes every factory secret even when all of them are set", () => {
    const env = buildAgentEnv({ ...process.env, ...SECRET_VALUES });

    for (const name of FACTORY_SECRET_ENV_KEYS) {
      expect(env, name).not.toHaveProperty(name);
    }
    for (const value of Object.values(SECRET_VALUES)) {
      expect(Object.values(env)).not.toContain(value);
    }
  });

  it("excludes every non-allowlisted variable", () => {
    const env = buildAgentEnv({ ...process.env, ...SECRET_VALUES });

    expect(env).not.toHaveProperty("SHELL");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("REPO_PATH");
  });

  it("keeps the secret list disjoint from the allowlist", () => {
    for (const secret of FACTORY_SECRET_ENV_KEYS) {
      expect(PROVIDER_ENV_KEYS as readonly string[]).not.toContain(secret);
    }
  });

  it("does not mutate the source env", () => {
    const source = { ANTHROPIC_API_KEY: "a", PATH: "/host" };

    buildAgentEnv(source);

    expect(source).toEqual({ ANTHROPIC_API_KEY: "a", PATH: "/host" });
  });
});
