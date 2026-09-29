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
import http from "node:http";
import https from "node:https";
import os from "node:os";
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

/**
 * Where the model actually lives, read out of the same models.json the agent
 * container will mount — so the pre-flight cannot disagree with the run.
 */
function endpoint(
  modelsFile: string,
  model: string
): { host: string; port: number; tls: boolean } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
      providers?: Record<string, { baseUrl?: string }>;
    };
    const providers = parsed.providers ?? {};
    const hinted = model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
    const key =
      providers[hinted]?.baseUrl ? hinted : Object.keys(providers).find((k) => providers[k]?.baseUrl);
    const base = key ? providers[key]?.baseUrl : undefined;
    if (!base) return undefined;
    const url = new URL(base);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      tls: url.protocol === "https:",
    };
  } catch {
    return undefined;
  }
}

/**
 * Ask the endpoint one cheap question before spending a graph's worth of
 * containers on it. A model server that is down or glacial produces exactly the
 * same all-red check list as a broken graph, and this is what tells them apart.
 */
async function preflight(): Promise<void> {
  const where = endpoint(MODELS_FILE, MODEL);
  if (!where) {
    console.log(`[pre-flight] no baseUrl found in ${MODELS_FILE} for ${MODEL}; skipping probe`);
    return;
  }
  const id = MODEL.includes("/") ? MODEL.slice(MODEL.indexOf("/") + 1) : MODEL;
  const started = Date.now();
  const secs = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  console.log(`[pre-flight] ${where.tls ? "https" : "http"}://${where.host}:${where.port} …`);

  const reply = await new Promise<string>((resolve) => {
    const transport = where.tls ? https : http;
    const req = transport.request(
      {
        host: where.host,
        port: where.port,
        path: "/v1/chat/completions",
        method: "POST",
        timeout: 180_000,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk));
        res.on("end", () => resolve(`${res.statusCode ?? "?"} ${body.slice(0, 120)}`));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => resolve(`error ${err.code ?? err.message}`));
    req.write(JSON.stringify({ model: id, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
    req.end();
  });

  console.log(`[pre-flight] ${secs()} -> ${reply}`);
  if (!reply.startsWith("200")) {
    skip(
      reply.startsWith("error ECONNREFUSED")
        ? `nothing is listening on ${where.host}:${where.port}`
        : `the model endpoint is not answering (${reply})`
    );
  }
  if (Date.now() - started > Number(process.env.AGENT_TIMEOUT_MS ?? 300_000) / 2) {
    console.log(
      "[pre-flight] WARNING: a single request already took longer than half of " +
        "AGENT_TIMEOUT_MS; one agent turn needs many of them."
    );
  }
}

/**
 * pi's `httpIdleTimeoutMs` defaults to 5 minutes and `retry.provider.timeoutMs`
 * inherits it, so a slow model fails *inside pi* well before AGENT_TIMEOUT_MS —
 * and it looks like a broken agent. settings.json is the only way to raise it in
 * a container, so when the caller has budgeted for slowness, write a settings
 * file that matches that budget instead of letting the default win.
 */
function ensureSettingsForSlowModel(): void {
  if (process.env.FACTORY_AGENT_SETTINGS_FILE) return;
  const budget = Number(process.env.AGENT_TIMEOUT_MS ?? "0");
  if (budget <= 300_000) return;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "factory-agent-settings-")), "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        httpIdleTimeoutMs: budget,
        retry: { provider: { timeoutMs: budget } },
      },
      null,
      2
    )
  );
  process.env.FACTORY_AGENT_SETTINGS_FILE = file;
  console.log(`[pre-flight] wrote ${file} (httpIdleTimeoutMs=${budget}) so a slow model is not cut off at pi's 5-minute default`);
}

await preflight();
ensureSettingsForSlowModel();
raiseOrchestratorCeiling();

/**
 * The same trap as `httpIdleTimeoutMs`, one level up (plan/open-issues #2).
 *
 * The orchestrator's wall clock now has a ceiling, so a smoke run that raised
 * `AGENT_TIMEOUT_MS` to give a slow local model room would still be cut off at
 * 45 minutes — and would look like a broken graph rather than a patient one.
 * Raise the ceiling to the derived budget unless the operator set it explicitly,
 * which is also how you test the cap itself.
 */
function raiseOrchestratorCeiling(): void {
  if (process.env.ORCHESTRATOR_TIMEOUT_MS) return;
  const child = Number(process.env.AGENT_TIMEOUT_MS ?? "0");
  if (!Number.isFinite(child) || child <= 0) return;
  const runs = Number(process.env.MAX_AGENT_RUNS ?? "12");
  const ceiling = Math.max(45 * 60_000, child * (runs + 1));
  process.env.ORCHESTRATOR_TIMEOUT_MS = String(ceiling);
  console.log(
    `[pre-flight] ORCHESTRATOR_TIMEOUT_MS=${ceiling} so the new cap does not cut off a slow run ` +
      `(set it yourself to exercise the cap)`
  );
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
  // The point of the usage columns: a card's cost should be readable without a
  // provider bill. NULL usage (a runtime that reported nothing) sums to 0 here,
  // which is why the run count travels with it.
  const spend = store.usageByCard().find((u) => u.card_id === CARD_ID);
  const spendText = spend
    ? [
        `${spend.input} in`,
        `${spend.output} out`,
        `${spend.cache_read} cache read`,
        `over ${spend.runs} runs`,
      ].join(" / ")
    : "(nothing recorded)";
  // The planner is not an `agent_runs` row, so its own spend is not in that sum.
  const orchestratorText = result.usage
    ? ` + orchestrator ${result.usage.input} in / ${result.usage.output} out`
    : "";
  console.log(`[smoke] spend     ${spendText}${orchestratorText}`);
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
