/** What the worker needs from any agent runtime (container or in-process). */
export interface AgentRunOptions {
  /** Directory the agent works in — a git worktree, bind-mounted as /work. */
  dir: string;
  /**
   * Shared `.git` of that worktree. The container runtime mounts it read-only so
   * the agent keeps `git log`/`diff`/`status`; the in-process runtime ignores it.
   */
  gitDir?: string;
  prompt: string;
  /** Called for every tool the agent starts, for Discord progress updates. */
  onTool?: (toolName: string) => void;
}

export type RunAgent = (opts: AgentRunOptions) => Promise<void>;

/** Outcome of one agent run. `text` leads with the failure reason when `!ok`. */
export interface AgentRunResult {
  ok: boolean;
  text: string;
}
