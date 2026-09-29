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

/**
 * Token counts as pi reports them on an assistant message's `usage`, summed
 * over one run. `input`/`output` are provider tokens; `cacheRead` is the cache
 * hit, which is the number that makes a long orchestrator session cheap or not.
 */
export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
}

/** Outcome of one agent run. `text` leads with the failure reason when `!ok`. */
export interface AgentRunResult {
  ok: boolean;
  text: string;
  /**
   * Absent when the runtime never reported a `usage` — an in-process runtime or
   * a container that died before its first `message_end`. Recorded as NULL, not
   * as zero, so a cost total cannot be read as "this run was free".
   */
  usage?: AgentTokenUsage;
}
