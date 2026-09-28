import { config } from "../config.js";
import { runAgentInContainer } from "../agent/container.js";
import { runAgentProcess } from "../agent/in-process.js";
import type { AgentRunOptions, RunAgent } from "../agent/types.js";
import { trello as defaultTrello } from "../trello/client.js";
import { github as defaultGithub } from "../github/client.js";
import {
  startedEmbed,
  progressEmbed,
  prReadyEmbed,
  failedEmbed,
  agentStartedEmbed,
  agentDoneEmbed,
  agentLabel,
} from "../discord/embeds.js";
import { runCardGraph, type GraphDeps, type GraphResult } from "../agents/graph.js";
import type { AgentEvent } from "../agents/spawn.js";
import type { DiscordBot } from "../discord/bot.js";
import { store as defaultStore, type Store } from "../state/store.js";
import {
  createWorktree,
  removeWorktree,
  pushBranch,
  commitWork,
  commonGitDir,
  type Worktree,
} from "./worktree.js";

// Types live in src/agent/types.js so the runtimes do not import the worker.
export type { AgentRunOptions, RunAgent } from "../agent/types.js";

/** The git-side operations runCard needs. */
export interface WorktreeOps {
  create(cardId: string, repoPath?: string): Worktree;
  remove(cardId: string, repoPath?: string): void;
  /** Shared `.git` the worktree links back to; handed to the agent runtime. */
  gitDir(dir: string): string;
  /** Host-side commit of everything the agent changed. False if nothing changed. */
  commit(dir: string, message: string): boolean;
  push(dir: string, branch: string): void;
}

export interface RunCardDeps {
  store?: Store;
  trello?: typeof defaultTrello;
  github?: typeof defaultGithub;
  worktree?: WorktreeOps;
  runAgent?: RunAgent;
  /**
   * The phase 2.2 graph runner. Injectable because a test must be able to drive
   * a whole card without docker, and the graph otherwise owns N containers.
   */
  graph?: (deps: GraphDeps) => Promise<GraphResult>;
}

/**
 * One agent's timeline entry, as Discord sees it: `[coder-1] tool: edit`.
 *
 * Children run in parallel, so these interleave by design — the role and run
 * prefix is what keeps an interleaved stream readable.
 */
async function reportAgentEvent(
  bot: DiscordBot,
  cardName: string,
  event: AgentEvent
): Promise<void> {
  switch (event.kind) {
    case "started":
      await bot.send(agentStartedEmbed(cardName, event.role, event.runId, event.task));
      return;
    case "done":
      await bot.send(agentDoneEmbed(cardName, event.role, event.runId, event.status));
      return;
    case "tool":
      await bot.send(
        progressEmbed(cardName, `[${agentLabel(event.role, event.runId)}] tool: ${event.toolName}`)
      );
      return;
  }
}

/** The instruction block every factory agent is started with. */
export function buildAgentPrompt(card: { name: string; desc: string }): string {
  return [
    `You are a factory coding agent. Complete this task from our Trello board.`,
    ``,
    `Task: ${card.name}`,
    card.desc ? `Details:\n${card.desc}` : ``,
    ``,
    `Rules:`,
    `- Work only in the current directory.`,
    `- Make the smallest correct change that fulfills the task.`,
    `- Run the project's tests if they exist; fix failures you cause.`,
    `- Do not commit or push — git metadata is mounted read-only where you run.`,
    `  Leave the change in the working tree; the factory commits it and opens the PR.`,
  ].join("\n");
}

/**
 * The default runtime: one throwaway container per run. Only the worktree (rw),
 * the repo's shared `.git` (ro) and allowlisted provider keys cross into it, so
 * a card that tells the agent to `printenv` or `cat <repo>/.env` finds neither.
 */
export const runAgentContainer: RunAgent = async ({
  dir,
  gitDir,
  prompt,
  onTool,
}: AgentRunOptions): Promise<void> => {
  const result = await runAgentInContainer({
    dir,
    gitDir,
    prompt,
    onTool,
    image: config.factory.agentImage,
  });
  if (!result.ok) throw new Error(result.text.trim() || "agent run failed");
};

/** `AGENT_RUNTIME=process` is a dev escape hatch; container is the default. */
export function selectAgentRuntime(): RunAgent {
  return config.factory.agentRuntime === "process" ? runAgentProcess : runAgentContainer;
}

/** Run one card end-to-end: worktree → container agent → commit → push → PR → CI. */
export async function runCard(
  cardId: string,
  bot: DiscordBot,
  deps: RunCardDeps = {}
): Promise<void> {
  const store = deps.store ?? defaultStore;
  const trello = deps.trello ?? defaultTrello;
  const github = deps.github ?? defaultGithub;
  const worktree: WorktreeOps = deps.worktree ?? {
    create: createWorktree,
    remove: removeWorktree,
    push: pushBranch,
    commit: commitWork,
    gitDir: commonGitDir,
  };
  const agent = deps.runAgent ?? selectAgentRuntime();
  // An explicit single-agent override always wins: it is the seam tests and
  // `AGENT_RUNTIME=process` use, and routing it through a graph would make
  // `deps.runAgent` mean two different things.
  const graphMode =
    deps.graph !== undefined || (!deps.runAgent && config.factory.agentGraph);

  const job = store.get(cardId);
  if (!job) return;
  const card = await trello.getCard(cardId);
  const { dir, branch } = worktree.create(cardId);
  const gitDir = worktree.gitDir(dir);
  store.setRunning(cardId, branch);
  await bot.send(startedEmbed(card.name, branch));

  try {
    if (graphMode) {
      const graph = deps.graph ?? runCardGraph;
      const outcome = await graph({
        store,
        cardId,
        baseDir: dir,
        gitDir,
        card,
        onEvent: (event) => {
          void reportAgentEvent(bot, card.name, event).catch(() => {});
        },
      });
      if (outcome.status !== "ok") {
        throw new Error(outcome.summary || `agent graph ${outcome.status}`);
      }
      // Children committed and merged onto the card branch already, so a clean
      // working tree here is the normal case and must not fail the run the way a
      // clean tree fails a single agent that was meant to leave changes behind.
      // Anything still uncommitted (a shared-role file the spawner could not
      // commit) is taken here.
      worktree.commit(dir, `factory: ${card.name}`);
    } else {
      await agent({
        dir,
        gitDir,
        prompt: buildAgentPrompt(card),
        onTool: (toolName) => {
          void bot.send(progressEmbed(card.name, `tool: ${toolName}`));
        },
      });

      // Commit on the host: the agent's container has no writable .git and no
      // push credentials, which is the point of the boundary.
      if (!worktree.commit(dir, `factory: ${card.name}`)) {
        throw new Error("the agent left no changes to ship");
      }
    }

    // Push branch and open PR
    worktree.push(dir, branch);
    const prUrl = await github.createPR(
      branch,
      `factory: ${card.name}`,
      `Auto-generated by the factory from [Trello card ${cardId}](${card.url})`
    );
    await bot.send(progressEmbed(card.name, `PR opened — waiting for CI: ${prUrl}`));

    // CI gate: only move to Review when CI passes
    const ci = await github.waitForCI(branch, {
      timeoutMs: config.factory.ciTimeoutMs,
    });
    if (ci !== "passed") {
      const msg = ci === "timeout" ? "CI timed out" : "CI failed";
      store.setFailed(cardId, msg);
      await bot.send(failedEmbed(card.name, `${msg} — ${prUrl}`));
      await trello
        .addComment(cardId, `Factory: ${msg}. PR: ${prUrl}`)
        .catch(() => {});
      return; // card stays in Ready for manual re-trigger
    }

    store.setReview(cardId, prUrl);
    await bot.send(prReadyEmbed(card.name, prUrl));
    await trello.moveCard(cardId, config.trello.reviewListId());
    // Bookkeeping only: the PR is open and green, so a Trello comment failure
    // must not flip a healthy run back to failed.
    await trello
      .addComment(cardId, `Factory opened PR: ${prUrl}`)
      .catch((err) => console.error("[runner] trello comment failed:", err));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setFailed(cardId, msg);
    await bot.send(failedEmbed(card.name, msg));
    await trello.addComment(cardId, `Factory run failed: ${msg}`).catch(() => {});
  } finally {
    worktree.remove(cardId);
  }
}
