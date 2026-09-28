/**
 * graph-smoke — drive one real card through the whole 2.2 stack.
 *
 *   TEST_LLM=1 AGENT_MODEL=<provider/id> \
 *     FACTORY_AGENT_MODELS_FILE=<pi models.json> npx tsx scripts/graph-smoke.ts
 *   (or: npm run test:graph-smoke with those exported)
 *
 * Opt-in and slow on purpose: it starts real agent containers and asks a real
 * model to plan, so it is the only thing in the repo that proves the pieces fit —
 * the orchestrator container, the baked spawn_agent extension, the host IPC
 * channel, child worktrees, host-side merges and the guardrails. `npm test` stays
 * hermetic and never runs this.
 *
 * What it asserts is the *shape* of a graph, not the model's prose: the card
 * branch must carry at least two merge commits, which only happens if the
 * orchestrator fanned out, each child wrote on its own branch, and the host
 * merged them back one at a time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runCardGraph } from "../src/agents/graph.js";
import type { AgentEvent } from "../src/agents/spawn.js";
import {
  commonGitDir,
  createWorktree,
  removeWorktree,
} from "../src/worker/worktree.js";
import { createStore } from "../src/state/store.js";
import { makeGitRepo, type GitRepoFixture } from "../test/helpers/git.js";

const ENABLED = process.env.TEST_LLM === "1";
const MODEL = process.env.AGENT_MODEL || "";
const MODELS_FILE = process.env.FACTORY_AGENT_MODELS_FILE || "";
const CARD_ID = "smoke0001";

function skip(reason: string): never {
  console.log(`SKIP graph-smoke: ${reason}`);
  console.log("  usage: TEST_LLM=1 AGENT_MODEL=<provider/id> \\");
  console.log("           FACTORY_AGENT_MODELS_FILE=<pi models.json> npm run test:graph-smoke");
  process.exit(0);
}

if (!ENABLED) skip("TEST_LLM is not 1 (this starts containers and spends a real model)");
if (!MODEL) skip("AGENT_MODEL is unset; refusing to smoke against whatever pi defaults to");
if (!MODELS_FILE || !fs.existsSync(MODELS_FILE)) {
  skip("FACTORY_AGENT_MODELS_FILE must point at a pi models.json the agent image can read");
}
try {
  execFileSync("docker", ["version"], { stdio: "ignore" });
} catch {
  skip("docker is not available");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** `git show <path>` throws on a missing file; a content check reads that as absent. */
function show(baseDir: string, revPath: string): string {
  try {
    return git(baseDir, "show", revPath);
  } catch {
    return "";
  }
}

// The same fixture the unit suite uses: a bare origin, a clone on `main` with one
// commit pushed, all under one temp dir so worktrees land beside the repo.
const fixture: GitRepoFixture = makeGitRepo();
const repoPath = fixture.repoPath;

// config.factory.repoPath() is a getter, so setting this now is enough for the
// worktree helpers the spawner calls with no repoPath argument.
process.env.REPO_PATH = repoPath;

const store = createStore(path.join(fixture.root, "smoke.db"));
const timeline: string[] = [];

const card = {
  name: "Add greet() and farewell() helpers",
  desc: [
    "Two separate helpers, in two separate files, with nothing shared between them:",
    "  1. src/greet.js exporting greet(name) returning the string `hi <name>`.",
    "  2. src/farewell.js exporting farewell(name) returning `bye <name>`.",
    "They must be independent: neither file imports the other.",
  ].join("\n"),
};

store.enqueue(CARD_ID, card.name);
const base = createWorktree(CARD_ID, repoPath);
const gitDir = commonGitDir(base.dir);

console.log(`[smoke] repo      ${repoPath}`);
console.log(`[smoke] base      ${base.dir} on ${base.branch}`);
console.log(`[smoke] model     ${MODEL}`);
console.log(
  `[smoke] limits    parallel=${process.env.MAX_PARALLEL_AGENTS ?? "default"} ` +
    `runs=${process.env.MAX_AGENT_RUNS ?? "default"} ` +
    `timeout=${process.env.AGENT_TIMEOUT_MS ?? "default"}`
);
console.log(`[smoke] card      ${card.name}`);

const onEvent = (event: AgentEvent): void => {
  const label =
    event.kind === "tool"
      ? `[${event.role}:${event.runId}] tool ${event.toolName}`
      : `${event.role}:${event.runId} ${event.kind}`;
  timeline.push(label);
  console.log(`[event] ${label}`);
};

let failed = false;
try {
  const started = Date.now();
  const result = await runCardGraph({
    store,
    cardId: CARD_ID,
    baseDir: base.dir,
    gitDir,
    card,
    onEvent,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  const merges = git(base.dir, "log", "--merges", "--oneline", base.branch)
    .split("\n")
    .filter(Boolean);
  const runs = store.runsFor(CARD_ID);
  const greet = show(base.dir, "HEAD:src/greet.js");
  const farewell = show(base.dir, "HEAD:src/farewell.js");

  console.log(`\n[smoke] status    ${result.status} in ${seconds}s (${result.runs} child runs)`);
  console.log(
    `[smoke] base head ${result.baseHeadBefore.slice(0, 7)} -> ${result.baseHeadAfter.slice(0, 7)}`
  );
  console.log(`[smoke] merges    ${merges.length}: ${merges.join(" | ") || "(none)"}`);
  console.log(`[smoke] runs      ${JSON.stringify(runs.map((r) => `${r.role}:${r.status}`))}`);
  console.log(`[smoke] timeline  ${timeline.length} events`);
  console.log(`[smoke] report    ${result.summary.slice(0, 700)}`);

  // When a child fails, the reason is in its own landing line, not in the
  // orchestrator's prose — and "the model 500'd" has to be tellable apart from
  // "the merge went wrong" without re-running anything.
  if (runs.some((r) => r.status !== "ok")) {
    for (const run of runs) {
      if (run.status === "ok") continue;
      const lines = (run.summary ?? "(no summary)").split("\n");
      console.log(`\n[smoke] --- ${run.role} ${run.run_id} (${run.status}) ---`);
      console.log(lines.slice(0, 7).map((line) => `  ${line}`).join("\n"));
    }
  }

  const checks: Array<[string, boolean]> = [
    ["the graph reported ok", result.status === "ok"],
    ["the base branch advanced", result.baseHeadAfter !== result.baseHeadBefore],
    ["at least two merge commits landed", merges.length >= 2],
    ["src/greet.js exists and says hi", /hi/.test(greet)],
    ["src/farewell.js exists and says bye", /bye/.test(farewell)],
    ["the two helpers are independent", !/farewell/.test(greet) && !/greet/.test(farewell)],
    ["agent_runs recorded the fan-out", runs.length >= 2],
    ["every recorded run finished", store.activeRuns(CARD_ID).length === 0],
    ["the children ran on separate branches", new Set(runs.map((r) => r.branch)).size >= 2],
    [
      "no child worktrees were left behind",
      !git(repoPath, "worktree", "list").includes(`wt-${CARD_ID}-c`),
    ],
    ["the child branches were deleted after merging", git(repoPath, "branch", "--list", `factory/${CARD_ID}-c`).trim() === ""],
  ];

  console.log("");
  // A provider outage looks identical to a broken graph in the check list above
  // (everything red, zero runs), so say which one this is before the reader
  // goes looking for a bug in src/agents.
  if (/server_error|Internal gateway|500|overloaded|no running instances/i.test(result.summary)) {
    console.log(
      "NOTE  the orchestrator's model request failed at the provider, so no plan\n" +
        "      was ever produced. That is an endpoint outage, not a graph failure:\n" +
        "      check with a direct call first, e.g.\n" +
        '      curl -sS $BASE/v1/chat/completions -d \'{"model":"…","messages":[{"role":"user","content":"hi"}]}\''
    );
    // The checks below still report the run honestly; only the ordering of blame
    // is corrected.
  }
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) failed = true;
  }
} catch (err) {
  console.error(`[smoke] threw: ${err instanceof Error ? err.stack : String(err)}`);
  failed = true;
} finally {
  removeWorktree(CARD_ID, repoPath);
  store.close();
  fixture.cleanup();
}

console.log(`\n${failed ? "SMOKE FAILED" : "SMOKE PASSED"}`);
process.exit(failed ? 1 : 0);
