import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Optional string env; empty string counts as unset. */
function opt(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

/** Numeric env with a fallback for missing / empty / non-numeric values. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  trello: {
    apiKey: () => req("TRELLO_API_KEY"),
    token: () => req("TRELLO_TOKEN"),
    boardId: () => req("TRELLO_BOARD_ID"),
    readyListId: () => req("READY_LIST_ID"),
    reviewListId: () => req("REVIEW_LIST_ID"),
    doneListId: () => req("DONE_LIST_ID"),
  },
  discord: {
    botToken: () => req("DISCORD_BOT_TOKEN"),
    channelId: () => req("DISCORD_CHANNEL_ID"),
  },
  github: {
    token: () => req("GITHUB_TOKEN"),
    owner: () => req("GITHUB_OWNER"),
    repo: () => req("GITHUB_REPO"),
    webhookSecret: () => opt("GITHUB_WEBHOOK_SECRET"),
  },
  factory: {
    repoPath: () => req("REPO_PATH"),
    // Getters (not snapshot-at-import) so `vi.stubEnv` works per test.
    get webhookPort(): number {
      return num("WEBHOOK_PORT", 8787);
    },
    get webhookSecret(): string {
      return opt("WEBHOOK_SECRET");
    },
    get ciTimeoutMs(): number {
      return num("CI_TIMEOUT_MS", 15 * 60_000);
    },
    /**
     * Where agent sessions run. `container` (default) keeps every secret on the
     * host; `process` runs pi inside this process and is dev-only.
     */
    get agentRuntime(): "container" | "process" {
      return opt("AGENT_RUNTIME", "container").toLowerCase() === "process"
        ? "process"
        : "container";
    },
    /** Image the agent containers are started from. */
    get agentImage(): string {
      return opt("AGENT_IMAGE", "factory-agent");
    },
  },
};
