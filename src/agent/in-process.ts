/**
 * In-process agent runtime — local dev convenience, NOT a security boundary.
 *
 * The agent shares this process, so it inherits the whole orchestrator
 * environment (`TRELLO_*`, `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, `WEBHOOK_SECRET`)
 * and can read any file the factory user can, including `<repo>/.env`. Use the
 * container runtime (`AGENT_RUNTIME=container`, the default) anywhere real
 * secrets are present. See plan/2.1-secret-isolation.md.
 */
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunOptions, RunAgent } from "./types.js";

let modelRuntime: ModelRuntime | undefined;

/** One pi session per card, disposed after the prompt. */
export const runAgentProcess: RunAgent = async ({
  dir,
  prompt,
  onTool,
}: AgentRunOptions): Promise<void> => {
  if (!modelRuntime) modelRuntime = await ModelRuntime.create();

  const { session } = await createAgentSession({
    cwd: dir,
    modelRuntime,
    sessionManager: SessionManager.inMemory(dir),
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") onTool?.(event.toolName);
  });

  await session.prompt(prompt);
  session.dispose();
}
