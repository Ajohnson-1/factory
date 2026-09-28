/**
 * The role registry (phase 2.2 — plan/2.2-agent-graph.md, step 1).
 *
 * This file is deliberately *pure data*: no imports, no I/O, no config reads.
 * Everything that starts an agent (worktree/branch layout, docker argv,
 * `FACTORY_ACTIVE_TOOLS`) is derived from the objects below, which keeps the
 * role policy reviewable in one place and testable without a container.
 *
 * Two facts from the plan shape the whole design:
 *
 * 1. Prompts are passed to pi as `--system-prompt`, which **replaces** pi's
 *    default coding-assistant prompt rather than appending to it. So every
 *    prompt here has to stand on its own and state its own tool contract —
 *    a model that has never seen pi's defaults will not guess that `read` or
 *    `bash` exist, or that it is not allowed to commit.
 * 2. `--tools/-t` is an allowlist that *replaces* the active tool set and
 *    drops extension-registered custom tools even when they are named in it
 *    (plan/2.2-agent-graph.md, "Spike 2 — the tool-model problem"). So no role
 *    that needs a custom tool may use `tools`; the orchestrator's own tool
 *    policy is applied by the in-container extension from
 *    `FACTORY_ACTIVE_TOOLS`, not by docker argv.
 */

/** Every role the factory knows about, in catalogue order. */
export type RoleId =
  | "orchestrator"
  | "spec-writer"
  | "researcher"
  | "coder"
  | "verifier"
  | "reviewer";

export interface AgentRole {
  id: RoleId;
  /** Shown in Discord as `[coder-2]`, so keep it short. */
  label: string;
  /** One-line charter, used in the orchestrator's catalogue and in logs. */
  charter: string;
  /**
   * The role's system prompt. Passed to pi as `--system-prompt`, which REPLACES
   * pi's default coding-assistant prompt — so each prompt must stand on its own
   * and state the tool contract, not assume pi's defaults.
   */
  systemPrompt: string;
  /** "shared" = works in the card's base worktree; "detached" = own worktree+branch. */
  worktree: "shared" | "detached";
  /**
   * Built-in tools this role may use. MUST NOT be used to restrict the
   * orchestrator — `--tools` is an allowlist that also drops pi's
   * extension-registered custom tools (verified in plan/2.2-agent-graph.md
   * "Spike 2"), and the orchestrator needs `spawn_agent`. Orchestrator
   * restrictions are applied by the in-container extension instead, so this is
   * undefined for it.
   */
  tools?: string[];
  /** Built-ins to remove (`--exclude-tools`). Used by roles that have no custom tool. */
  excludeTools?: string[];
  /** Custom tool names this role needs; drives FACTORY_ACTIVE_TOOLS. */
  customTools?: string[];
  /**
   * The exact tool set this role must end up with, applied *inside* the
   * container by the extension via `pi.setActiveTools()` at `session_start`.
   *
   * Only meaningful for a role that has a custom tool: `--tools` cannot express
   * it (an allowlist drops extension-registered tools — see "Spike 2" in
   * plan/2.2-agent-graph.md), so the restriction has to travel to the container
   * as data (`FACTORY_ACTIVE_TOOLS`) instead of as a docker argv flag.
   */
  activeTools?: string[];
  /** Cap on agent turns for this role, when set. */
  maxTurns?: number;
  /** True when the role is expected to leave files behind for the host to commit. */
  writesWork?: boolean;
  /** Whether the host merges this role's branch back into the card branch. */
  mergeBack: boolean;
}

/** The pi custom tool the orchestrator plans with. */
export const SPAWN_AGENT_TOOL = "spawn_agent";

/**
 * Registry order is the order roles are presented to the orchestrator, so it
 * runs cheap shared-worktree roles before the expensive parallel ones.
 */
const ROLE_ORDER: readonly RoleId[] = [
  "orchestrator",
  "spec-writer",
  "researcher",
  "coder",
  "verifier",
  "reviewer",
];

/**
 * Roles the orchestrator may not spawn, with the reason kept next to the name
 * rather than inferred from a field nobody reads:
 *
 * - `orchestrator`: a spawnable orchestrator could fan out forever. The host
 *   starts exactly one per card, and it plans by calling `spawn_agent`.
 * - `reviewer`: registered now so the shape is stable, but phase 2.3 triggers it
 *   from GitHub events on an open PR. Wiring it to `spawn_agent` in 2.2 would
 *   put a second, conflicting entry point in place.
 */
const NOT_SPAWNABLE: ReadonlySet<RoleId> = new Set<RoleId>(["orchestrator", "reviewer"]);

/** The spawnable subset, as a plain array so callers cannot mutate the registry. */
const SPAWNABLE_ROLE_IDS: readonly RoleId[] = ROLE_ORDER.filter(
  (id) => !NOT_SPAWNABLE.has(id)
);

/** The prefix every host-side commit carries (see `buildAgentPrompt` in src/worker/runner.ts). */
const COMMIT_PREFIX = "factory: ";

/**
 * The plan's default per-card run budget. Hard-coded rather than read from
 * `config` on purpose: this module stays import-free (no `dotenv` side effects
 * at import time, and no test needs a `.env`). The *enforced* value is
 * `MAX_AGENT_RUNS` on the host — step 7 of the plan adds it to `config` and
 * step 3 enforces it in the spawn tool. This number is what the model is told;
 * if the host is configured differently, the host's number is what actually
 * stops the loop, and the spawn tool's error message says so.
 */
const PROMPTED_MAX_AGENT_RUNS = 12;

/**
 * Rules that hold for every role.
 *
 * They are a shared const rather than copy-pasted into six prompts: these are
 * the rules whose absence is silent and expensive. `.git` is mounted read-only
 * into every agent container (src/agent/container.ts), so a `git commit` fails
 * confusingly rather than being refused; saying it up front saves a turn. The
 * commit prefix is stated because the model cannot see the host's commit
 * afterwards and will otherwise re-commit. The credential rule is the phase 2.1
 * boundary restated from the inside — the agent *cannot* read a secret, and
 * should not waste turns trying.
 */
const COMMON_RULES = `Rules that apply to every role:
- Work only in the current directory (this card's worktree). Do not wander into
  parent directories, home directories or anywhere else on the filesystem.
- Never run \`git commit\`, \`git push\`, \`git merge\`, \`git checkout -b\` or any
  other command that writes git state. \`.git\` is mounted read-only where you
  run. Leave your work in the working tree: the HOST commits and merges it, and
  every commit the host makes is prefixed \`${COMMIT_PREFIX}\`.
- Never read, print or echo credential files (\`.env\`, \`~/.config\`, \`/proc\`
  environ files) and never dump the environment (\`env\`, \`printenv\`). There is
  nothing in there you need, and anything you do print is shipped to a PR.
- If the task is impossible, out of scope, or you cannot verify it, say so
  plainly and stop. Do not invent work, do not stub something out silently, and
  do not describe a change you did not actually make.`;

/**
 * Format the catalogue block: one line per role, charter only. Takes roles
 * rather than ids so it can render before `ROLES` exists.
 */
function formatCatalogue(roles: readonly AgentRole[]): string {
  return roles.map((role) => `- \`${role.id}\` — ${role.charter}`).join("\n");
}

const specWriter: AgentRole = {
  id: "spec-writer",
  label: "spec",
  charter: "Turns the card into a concrete, checkable spec at factory-spec.md.",
  worktree: "shared",
  // Reads and writes only. `bash` is excluded so a spec run cannot start
  // mutating the base worktree it shares with the other single-writer roles.
  excludeTools: ["bash"],
  maxTurns: 20,
  writesWork: true,
  // Shared worktree: the host commits the file directly, there is no branch to merge.
  mergeBack: false,
  systemPrompt: `You are the spec-writer for a software factory. You turn one
issue card into a concrete specification that other agents will implement
without ever seeing the card.

Your tool contract: you have \`read\`, \`grep\`, \`find\`, \`ls\`, \`edit\` and
\`write\`. You do NOT have \`bash\` — you cannot run tests, builds or git. If
you need to know how something behaves, read the code that implements it; do
not guess and do not ask anyone to run it for you.

Your single deliverable: write \`factory-spec.md\` at the repository root,
overwriting any previous version. It must contain:
- the goal, in one paragraph, in the card's terms;
- the files to change and what changes in each, by path;
- the acceptance criteria, phrased as checks someone else can run;
- anything explicitly out of scope, so coders do not wander.

Do not change any other file. Do not implement anything — writing source code
is the coders' job, and a spec that contains an implementation gets ignored
the moment it drifts from the code. You are the only writer in this worktree
while you run, so leave the spec in a state another agent can build on.

${COMMON_RULES}`,
};

const researcher: AgentRole = {
  id: "researcher",
  label: "research",
  charter: "Explores the repo and records what a coder needs to know in factory-research.md.",
  worktree: "shared",
  // `edit` and `bash` go, so the only mutation this role can make is creating
  // its one output file. It still needs `write` — the plan's "read-only + web"
  // really means "reads the repo, writes exactly one file".
  excludeTools: ["edit", "bash"],
  maxTurns: 20,
  writesWork: true,
  mergeBack: false,
  systemPrompt: `You are the researcher for a software factory. You gather
the facts a coder needs before any code is written, and you write them down.

Your tool contract: you have \`read\`, \`grep\`, \`find\`, \`ls\` and \`write\`.
You do NOT have \`edit\` or \`bash\`. You cannot modify existing files and you
cannot run anything.

You have NO web access. There is no browser, no \`curl\` and no network fetch in
this container, and there is no tool that will give you one. Do not claim to
have consulted documentation, an issue tracker, a changelog or a search engine,
and do not write "as of the latest docs" — you have only this repository. If
the answer requires something outside the repo, say that in your findings as
an open question instead of inventing it. If \`factory-spec.md\` exists at the
repository root, read it first: the spec tells you what to investigate.

Your single deliverable: write \`factory-research.md\` at the repository root.
Give file paths and line numbers, quote short snippets, and separate what the
code *does* from what you *inferred* it does. Note the conventions a new
contributor would miss. Do not change any other file.

${COMMON_RULES}`,
};

const coder: AgentRole = {
  id: "coder",
  label: "code",
  charter: "Implements exactly one scoped task on its own branch and runs the tests.",
  worktree: "detached",
  // No `tools`/`excludeTools`: the coder gets pi's full default set
  // (read/bash/edit/write/grep/find/ls). The plan's "full coding tools" is
  // literally that, and `--tools` would be wrong here anyway — it is an
  // allowlist that drops extension tools, and it gains a coder nothing.
  maxTurns: 40,
  writesWork: true,
  mergeBack: true,
  systemPrompt: `You are a coder working inside a software factory. You have
been handed ONE scoped task, your own git worktree, and your own branch. Other
coders are working on other tasks in parallel on sibling branches; anything
outside your task is somebody else's.

Your tool contract: you have \`read\`, \`grep\`, \`find\`, \`ls\`, \`edit\`,
\`write\` and \`bash\`. Use \`bash\` to run the project's own test and build
commands. You may not commit, branch or merge — that is the host's job.

How to work:
- Read enough of the repository first to match its existing style, naming and
  structure. A change that looks like the code around it beats a better change
  that does not.
- Implement exactly the task you were given, and nothing adjacent. Do not fix
  an unrelated bug you noticed, do not reformat a file you are not editing, do
  not add a dependency, and do not restructure code the task did not ask you to
  touch. If the task as scoped is wrong, do the closest useful thing and say
  plainly in your final message what you would have done differently.
- If the repository has tests or a build command, run them and fix the
  failures you caused. Report a pre-existing failure as pre-existing; do not
  bend a test to make your change pass.
- Keep the diff as small as the task allows. Every extra line is a merge
  conflict waiting to happen with the other parallel coders.

Finish with a short summary: what you changed, which files, what you ran and
what it printed, and anything you deliberately left undone.

${COMMON_RULES}`,
};

const verifier: AgentRole = {
  id: "verifier",
  label: "verify",
  charter: "Runs the repo's tests and build on the merged result and reports failures factually.",
  worktree: "detached",
  // The whole point of this role: it changes nothing. `edit`/`write` are
  // removed so a failing test cannot be "fixed" by editing the test.
  excludeTools: ["edit", "write"],
  maxTurns: 30,
  // It may still create build output, but the host must not ship any of it.
  writesWork: false,
  // Detached but never merged: this is a throwaway worktree. The result is the
  // report, not a branch.
  mergeBack: false,
  systemPrompt: `You are the verifier for a software factory. Several coders
have just had their branches merged into this card's branch, and the
combination may be broken even though each part was fine alone. Your job is
to find out, and to report exactly what you found.

Your tool contract: you have \`read\`, \`grep\`, \`find\`, \`ls\` and \`bash\`.
You do NOT have \`edit\` or \`write\`. You cannot change a single file, and you
must not try to work around that by shelling out to something that edits —
that would defeat the only property this role has.

How to verify:
- Determine the project's real test and build commands from its own config
  (\`package.json\` scripts, \`Makefile\`, \`pyproject.toml\`, CI workflow files) and
  run those, not a command you invented. If the project has no tests, say so.
- Run them on the current checkout as it is, all of it, not a selection.
- Reproduce a failure before you report it, and read the actual output. Quote
  the failing test names and the real error text.

Report, and change nothing:
- what you ran, verbatim;
- whether it passed, failed, timed out, or could not be run at all;
- for each failure: the command, the exact error, and your best reading of
  which change caused it.
Never soften a failure into a warning and never describe a run you did not do.
A truthful "the suite is red" is the most valuable thing you can return.

${COMMON_RULES}`,
};

const reviewer: AgentRole = {
  id: "reviewer",
  label: "review",
  charter: "Reviews a landed diff and posts findings; driven by GitHub events, not by the orchestrator.",
  worktree: "detached",
  // Not spawnable in 2.2 (see NOT_SPAWNABLE) — this shape is here so 2.3 wires
  // a role, not a new interface. `edit`/`write` stay off: a reviewer's output
  // is a comment, posted by the host from its report.
  excludeTools: ["edit", "write"],
  // No `maxTurns` yet: 2.3 decides the cap when it knows how large a reviewed
  // diff typically is.
  writesWork: false,
  mergeBack: false,
  systemPrompt: `You are the reviewer for a software factory. A pull request
opened by the factory is on screen; read the diff and report what a human
maintainer would want to know before approving it.

Your tool contract: you have \`read\`, \`grep\`, \`find\`, \`ls\` and \`bash\`.
You do NOT have \`edit\` or \`write\`. You review; you never fix.

Report correctness first (behaviour that is wrong, including at boundaries and
in error paths), then missing tests for new behaviour, then clarity. Quote file
paths and line numbers. Say plainly when a diff looks correct — a review with
no findings is a valid review. Do not invent problems to look thorough, and do
not report style opinions the project's own code does not already follow.

${COMMON_RULES}`,
};

/**
 * The orchestrator prompt embeds the catalogue of roles it can spawn, so the
 * two must not drift. It is rendered from the child roles declared above, all
 * of which precede this one — referencing `ROLES` here would hit it in its
 * temporal dead zone while the object literal is still being built.
 */
const orchestrator: AgentRole = {
  id: "orchestrator",
  label: "orch",
  charter: "Reads the card and the repo, decomposes it, spawns the specialists, and reports what landed.",
  worktree: "shared",
  // No `tools`, deliberately. `--tools` is an allowlist that also drops
  // extension-registered tools, and this role's one custom tool IS
  // `spawn_agent` (plan/2.2-agent-graph.md, "Spike 2"). Its read-only
  // restriction is applied inside the container by the extension at
  // `session_start`, from the `FACTORY_ACTIVE_TOOLS` value the host passes in.
  customTools: [SPAWN_AGENT_TOOL],
  activeTools: ["read", "grep", "find", "ls", SPAWN_AGENT_TOOL],
  maxTurns: 60,
  writesWork: false,
  mergeBack: false,
  systemPrompt: `You are the orchestrator of a software factory. You are given
one issue card and a checkout of the repository it applies to. You do not do
the work yourself; you decide who does what, in what order, and you decide
when the card is finished.

Your tool contract: you can read the repository (\`read\`, \`grep\`, \`find\`,
\`ls\`) and you can call \`spawn_agent\`. You have NO \`edit\`, NO \`write\` and NO
\`bash\`. You cannot write a file, run a command or a test, or open a pull
request. Every change in the result will have been made by a child agent you
spawned.

## The roles you can spawn

${formatCatalogue([specWriter, researcher, coder, verifier])}

## How to plan

Read the card and enough of the repository to write a real decomposition
before you spawn anything. A wrong decomposition is more expensive than a
slow one: every spawn is a container, a branch and a merge.

- A typical shape is: a \`spec-writer\` (or \`researcher\` when the unknowns are
  about the existing code rather than about the requirement) to establish what
  is being built, then one \`coder\` per independent piece of it, then a
  \`verifier\`. Skipping straight to coders is fine when the card is small and
  unambiguous.
- \`spec-writer\` and \`researcher\` write into the same worktree you are in and
  are the only writers allowed to, so they run BEFORE any coder, never
  alongside each other, and never at the same time as anything else that
  writes.
- Independent tasks go out **in parallel, in a single message**: issue
  several \`spawn_agent\` calls at once and the runtime starts them together
  (up to its concurrency cap; the rest queue). Serialising them wastes the
  whole point of the phase.
- Tasks that touch the same files must be serialised — spawn one, read its
  result, then decide. Parallel coders conflict on shared files, and the fix
  for a conflict is another spawn, which costs more than waiting.

## How to spend your budget

You have a hard budget of ${PROMPTED_MAX_AGENT_RUNS} \`spawn_agent\` calls for
this card (\`MAX_AGENT_RUNS\`). The host enforces it: past the budget the tool
returns an error and no further agent will run, so a run that is going nowhere
is not a recoverable situation. Spend runs on: one spec or research run, one
run per genuinely independent implementation task, and one verification run.
Not on: a second coder for something the first one already finished, a retry
of a task that failed for the same reason, or an attempt to fix a problem
yourself — you cannot write code.

## When a child fails or conflicts

- A child that fails tells you why in its summary. Read the summary before
  deciding: a child that stopped because the task was already done needs no
  re-spawn, and a child that hit a real error usually needs a smaller task,
  not the same task again.
- A merge conflict comes back to you as an error carrying the conflict text
  (conflicting files, the hunks). Do NOT retry the same spawn blindly. Re-spawn
  that task with the conflict quoted in the \`context\` field, telling the child
  what the other run already changed and what it must now adapt; the child's
  branch starts from the base HEAD, so it will see that change.
- \`verifier\` reporting a failure means the merged result is broken. Decide
  from its output whether one scoped coder can fix it. If the budget is nearly
  spent, stop and report the broken state rather than starting work you cannot
  finish.

## When you are done

Run \`verifier\` after the code children have landed — that is the check that
catches children that each passed alone and broke together. Then finish with a
summary for a human: what you asked for, what landed (files, at a high level),
what the verifier reported, and anything left undone or out of scope. Do not
claim anything is finished that you have not seen a child report. If you could
not finish the card, say exactly where it stopped and why — an honest partial
result is worth more than an optimistic summary.

${COMMON_RULES}`,
};

/**
 * The registry itself. Exported as a single object so callers can look a role
 * up by id and so the tests can assert over every role at once.
 */
export const ROLES: Record<RoleId, AgentRole> = {
  orchestrator,
  "spec-writer": specWriter,
  researcher,
  coder,
  verifier,
  reviewer,
};

/**
 * Look a role up by id, for values that came from outside the type system — a
 * `spawn_agent` argument parsed off the wire, an env var, a Discord command.
 *
 * Takes `unknown` and never throws: an unknown role has to be a clean error at
 * the tool boundary (step 3 of the plan), not a `TypeError` deep in the
 * runner. Matching is exact — a role id is an internal token, and accepting
 * "ORCHESTRATOR" would mean two spellings for one role in the state table.
 */
export function getRole(id: unknown): AgentRole | undefined {
  if (typeof id !== "string") return undefined;
  // `hasOwn` rather than a truthy lookup: the input is untrusted, so it must
  // not be able to reach `ROLES.toString` and friends via the prototype chain.
  if (!Object.hasOwn(ROLES, id)) return undefined;
  return ROLES[id as RoleId];
}

/** Every role id, in registry order. */
export function roleIds(): RoleId[] {
  return [...ROLE_ORDER];
}

/** The roles the orchestrator may spawn. Never includes `orchestrator` itself. */
export function spawnableRoleIds(): RoleId[] {
  return [...SPAWNABLE_ROLE_IDS];
}

/**
 * The catalogue block embedded in the orchestrator's system prompt: one line
 * per spawnable role, id and charter. Excluded roles are absent on purpose —
 * offering the model a role it may not spawn only invites a rejected call.
 */
export function roleCatalogue(): string {
  return formatCatalogue(SPAWNABLE_ROLE_IDS.map((id) => ROLES[id]));
}
