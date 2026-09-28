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
    /**
     * `docker run --memory` for every agent container. Phase 2.2 runs N children
     * at once, so the cap is per container, not per card. Set empty to lift it.
     */
    get agentMemory(): string {
      return opt("AGENT_MEMORY", "2g");
    },
    /** `docker run --cpus` for every agent container. Set 0 to lift it. */
    get agentCpus(): number {
      return num("AGENT_CPUS", 1);
    },
    /**
     * How many child containers one card may have running at once. Children are
     * the point: N coders at `AGENT_MEMORY` each is the number that can hurt the
     * host, so this caps the fan-out the orchestrator can ask for.
     */
    get maxParallelAgents(): number {
      return Math.max(1, num("MAX_PARALLEL_AGENTS", 4));
    },
    /** Per-child wall clock. On expiry the container is killed, not just abandoned. */
    get agentTimeoutMs(): number {
      return num("AGENT_TIMEOUT_MS", 20 * 60_000);
    },
    /**
     * Hard budget of agent runs per card, so an orchestrator that loops cannot
     * spend unbounded tokens. Told to the orchestrator in its system prompt and
     * enforced on the host, which is the only place that can actually refuse.
     */
    get maxAgentRuns(): number {
      return num("MAX_AGENT_RUNS", 12);
    },
    /** Model pattern for every agent run. Empty keeps pi's own default. */
    get agentModel(): string {
      return opt("AGENT_MODEL");
    },
    /** Model for the orchestrator only — it is the long-lived, expensive session. */
    get orchestratorModel(): string {
      return opt("ORCHESTRATOR_MODEL") || opt("AGENT_MODEL");
    },
    /**
     * Whether a card is driven by an orchestrator agent that fans out children
     * (phase 2.2) or by the MVP's single agent per card. On by default; off is
     * the escape hatch for a card whose graph misbehaves, since the two paths
     * differ only in who decides the work.
     */
    get agentGraph(): boolean {
      return opt("AGENT_GRAPH", "1").toLowerCase() !== "0";
    },
    /**
     * Address the host's spawn-IPC listener binds to. Loopback by default, and
     * loopback is what works on Docker Desktop (verified: a container reaches a
     * host `127.0.0.1` listener through `host.docker.internal`). On a Linux host
     * `--add-host=host.docker.internal:host-gateway` arrives at the bridge
     * address instead, so a real deployment has to widen this — and then a
     * per-run token is the only thing gating an endpoint that starts containers.
     */
    get ipcBind(): string {
      return opt("FACTORY_IPC_BIND", "127.0.0.1");
    },
    /** 0 lets the OS pick a free port, which is what parallel cards need. */
    get ipcPort(): number {
      return num("FACTORY_IPC_PORT", 0);
    },
    /** Extra seconds the in-container tool waits on the host before giving up. */
    get ipcSlackMs(): number {
      return num("FACTORY_IPC_SLACK_MS", 60_000);
    },
    /**
     * Host path to a pi `models.json` (custom/openai-compatible endpoints),
     * mounted read-only into every agent container. Off by default: the two
     * mount paths are the agent's whole filesystem view and adding a third has
     * to be a deliberate choice. It is how the local test models reach agents.
     */
    get agentModelsFile(): string {
      return opt("FACTORY_AGENT_MODELS_FILE");
    },
  },
};
