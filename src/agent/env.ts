/**
 * The environment an agent container is allowed to see (phase 2.1).
 *
 * The orchestrator process holds every factory secret (Trello, GitHub, Discord,
 * webhook). An agent runs arbitrary commands through its `bash` tool, so
 * whatever we hand it must be built from this allowlist — never from a copy of
 * `process.env`.
 */

/** Provider API keys pi reads from the environment (pi docs/providers.md). */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
] as const;

/**
 * Orchestrator-only names. None of these appear in `PROVIDER_ENV_KEYS`, and
 * tests assert they never reach an agent even when set in the host env. Add to
 * this list whenever the orchestrator learns a new secret.
 */
export const FACTORY_SECRET_ENV_KEYS = [
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
  "TRELLO_APP_SECRET",
  "GITHUB_TOKEN",
  "DISCORD_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
] as const;

/** Container-side paths. Keep in sync with deploy/docker/factory-agent.Dockerfile. */
export const AGENT_CONTAINER_HOME = "/home/agent";
export const AGENT_CONTAINER_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Build the agent env from `source` (defaults to the orchestrator's own env).
 *
 * PATH and HOME are container constants rather than inherited host values: the
 * agent's home must live inside the container image, and inheriting the host
 * `HOME` would point pi's config dir at a path that is not mounted. Only
 * provider keys that are actually set are passed through.
 */
export function buildAgentEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: AGENT_CONTAINER_PATH,
    HOME: AGENT_CONTAINER_HOME,
  };
  for (const key of PROVIDER_ENV_KEYS) {
    const value = source[key];
    if (value && value.trim()) env[key] = value;
  }
  return env;
}
