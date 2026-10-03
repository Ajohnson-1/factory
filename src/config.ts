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
    /**
     * The OAuth 1.0 app secret from https://trello.com/apps/admin. Trello signs
     * every delivery with it (`X-Trello-Webhook`) and there is no other inbound
     * credential available, because Trello cannot set custom request headers.
     *
     * Optional in the type, mandatory in behaviour: `verifyTrelloSignature`
     * refuses every delivery while it is unset. It used to be the reverse — an
     * unset `WEBHOOK_SECRET` left `/webhook/trello` open to anyone who could
     * reach it, and a set one locked out Trello itself.
     */
    appSecret: () => opt("TRELLO_APP_SECRET"),
    /**
     * Our own public callback URL, e.g. https://vps.example/webhook/trello.
     * Part of the signed content: the docs say the body is hashed with "the
     * callbackURL exactly as it was provided during webhook creation", so a
     * trailing slash here that the registration did not use is a signature
     * mismatch, not a typo. Same value the registration script sends.
     */
    webhookUrl: () => opt("TRELLO_WEBHOOK_URL"),
    /**
     * Debug capture: append every inbound delivery to this file as JSON lines.
     * Raw bodies contain card names and descriptions, so this is a path an
     * operator sets deliberately on the host, and nothing here sends a body to
     * Discord or to the normal log. Empty disables it.
     */
    webhookDebugFile: () => opt("TRELLO_WEBHOOK_DEBUG_FILE"),
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
    /**
     * API root. The default is GitHub's own; it is overridable for one reason — so
     * `scripts/review-smoke.ts` can point the real Octokit client at a local sink
     * and assert what a review actually put on the wire. Posting factory reviews at
     * a real repository to test them is not something an opt-in check should do
     * unasked.
     */
    apiBaseUrl: () => opt("GITHUB_API_BASE_URL", "https://api.github.com"),
  },
  factory: {
    repoPath: () => req("REPO_PATH"),
    // Getters (not snapshot-at-import) so `vi.stubEnv` works per test.
    get webhookPort(): number {
      return num("WEBHOOK_PORT", 8787);
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
     * Ceiling on the orchestrator's own wall clock, whatever the per-child
     * budget would imply.
     *
     * The planner's timeout is derived as `AGENT_TIMEOUT_MS × (MAX_AGENT_RUNS +
     * 1)` — 260 minutes at defaults — and the worker runs one card at a time,
     * so without a cap a single hung planner delays every other card by hours.
     * Floored at one child timeout inside `orchestratorTimeoutMs`.
     */
    get orchestratorTimeoutMs(): number {
      return num("ORCHESTRATOR_TIMEOUT_MS", 45 * 60_000);
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
     * The `--add-host` spec that makes the host reachable *from* a container, or
     * empty to add nothing.
     *
     * This exists because widening `FACTORY_IPC_BIND` is only half the Linux fix.
     * Docker Engine does not define `host.docker.internal` at all, so on a Linux
     * host the name simply fails to resolve and no bind value can save it; the
     * mapping `host.docker.internal:host-gateway` is what creates it. On Docker
     * Desktop the name is already built in and already reaches a loopback
     * listener, which is the arrangement `scripts/graph-smoke.ts` passes with —
     * overriding it there would trade a Linux hole for a Mac hole. So the default
     * is empty, and `deploy/configure-env.sh` writes the mapping on Linux only.
     */
    get ipcAddHost(): string {
      return opt("FACTORY_IPC_ADD_HOST");
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
    /**
     * Host path to a pi `settings.json`, mounted read-only next to models.json.
     *
     * This exists for one setting: `httpIdleTimeoutMs`, which defaults to 300000
     * (5 min) and is what `retry.provider.timeoutMs` inherits. A slow local model
     * server therefore fails *inside pi* long before `AGENT_TIMEOUT_MS` is
     * reached, and the failure looks like a broken agent rather than a patient
     * one. There is no CLI flag or env var for it — settings.json is the only way
     * in, and the container has no access to the host's.
     */
    get agentSettingsFile(): string {
      return opt("FACTORY_AGENT_SETTINGS_FILE");
    },
    /**
     * Line comments one review may post. A reviewer that gets enthusiastic about
     * naming would otherwise turn a PR into a wall of findings, and GitHub's
     * review API takes them all in one call, so there is no natural backpressure.
     */
    get reviewMaxComments(): number {
      return Math.max(0, num("REVIEW_MAX_COMMENTS", 20));
    },
    /**
     * Reviews one card may ever have, across every push to every PR.
     *
     * `MAX_AGENT_RUNS` cannot cover this: it counts graph children inside one
     * attempt, and reviews are not graph children — they are triggered by GitHub
     * events and deliberately do not appear in `agent_runs` (see
     * `src/reviewer/reviewer.ts`'s header for why putting them there would let a
     * PR push eat a coder's budget). Without a cap of its own, a card pushed on
     * every CI fix has no ceiling at all.
     */
    get reviewMaxRunsPerCard(): number {
      return Math.max(0, num("REVIEW_MAX_RUNS_PER_CARD", 5));
    },
    /** Wall clock for one review container. Falls back to `AGENT_TIMEOUT_MS`. */
    get reviewTimeoutMs(): number {
      return num("REVIEW_TIMEOUT_MS", config.factory.agentTimeoutMs);
    },
    /** Model for the reviewer; falls back to `AGENT_MODEL`, like the orchestrator. */
    get reviewerModel(): string {
      return opt("REVIEWER_MODEL") || opt("AGENT_MODEL");
    },
  },
};
