import { describe, it, expect } from "vitest";
import {
  ROLES,
  SPAWN_AGENT_TOOL,
  getRole,
  roleCatalogue,
  roleIds,
  spawnableRoleIds,
  type AgentRole,
  type RoleId,
} from "../../src/agents/roles.js";

/** The ids the plan's registry table lists (plan/2.2-agent-graph.md). */
const ALL_ROLE_IDS: RoleId[] = [
  "orchestrator",
  "spec-writer",
  "researcher",
  "coder",
  "verifier",
  "reviewer",
];

/**
 * Prompts are shipped as `--system-prompt`, which *replaces* pi's default
 * prompt, so a stub prompt is not caught by anything until an agent runs
 * badly in a container. 40 words is roughly two sentences: below that a role
 * has almost certainly lost its tool contract.
 */
const MIN_PROMPT_WORDS = 40;

/** Look a role up; the tests below only run over ids known to exist. */
function role(id: RoleId): AgentRole {
  const found = getRole(id);
  if (!found) throw new Error(`role missing from registry: ${id}`);
  return found;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A role is read-only when every built-in that can change a file is gone. */
function isReadOnly(r: AgentRole): boolean {
  const excluded = r.excludeTools ?? [];
  return excluded.includes("edit") && excluded.includes("write");
}

describe("ROLES registry", () => {
  it("contains every role in the plan, and nothing else", () => {
    expect(Object.keys(ROLES).sort()).toEqual([...ALL_ROLE_IDS].sort());
  });

  it("keys the record by the id each role carries", () => {
    for (const id of roleIds()) {
      expect(role(id).id).toBe(id);
    }
  });

  it("gives every role a short label", () => {
    // Labels are prefixed onto Discord progress messages as `[coder-2]`, so a
    // paragraph-length label would be the only thing anyone sees.
    for (const id of roleIds()) {
      expect(role(id).label.length, id).toBeGreaterThan(0);
      expect(role(id).label.length, id).toBeLessThanOrEqual(12);
    }
  });

  it("gives every role a non-empty charter and role id", () => {
    for (const id of roleIds()) {
      expect(role(id).charter.trim().length, id).toBeGreaterThan(0);
    }
  });
});

describe("system prompts", () => {
  it("are non-empty and above the word-count floor for every role", () => {
    for (const id of roleIds()) {
      const prompt = role(id).systemPrompt;
      expect(prompt.trim().length, id).toBeGreaterThan(0);
      expect(words(prompt), `${id} prompt is too thin to be a real prompt`).toBeGreaterThanOrEqual(
        MIN_PROMPT_WORDS
      );
    }
  });

  it("state the tool contract, since --system-prompt replaces pi's defaults", () => {
    // A prompt that never names a tool leaves the model guessing which of
    // read/bash/edit/write it has.
    for (const id of roleIds()) {
      expect(role(id).systemPrompt, id).toMatch(/`(read|bash|spawn_agent)`/);
    }
  });

  it("carry the shared rules: no git writes, the commit prefix, no secrets", () => {
    for (const id of roleIds()) {
      const prompt = role(id).systemPrompt;
      expect(prompt, id).toContain("git commit");
      expect(prompt, id).toContain("factory: ");
      expect(prompt, id).toContain("printenv");
    }
  });

  it("tell the orchestrator it cannot write, spawns, and stops when done", () => {
    const prompt = role("orchestrator").systemPrompt;

    expect(prompt).toContain(SPAWN_AGENT_TOOL);
    expect(prompt).toMatch(/NO .*edit.*NO .*write.*NO\s+`bash`/s);
    expect(prompt).toMatch(/parallel, in a single message/i);
    expect(prompt).toContain("MAX_AGENT_RUNS");
    expect(prompt).toContain("verifier");
    expect(prompt).toMatch(/conflict/i);
  });

  it("point spec-writer and researcher at their output files at the repo root", () => {
    expect(role("spec-writer").systemPrompt).toContain("factory-spec.md");
    expect(role("researcher").systemPrompt).toContain("factory-research.md");
    expect(role("spec-writer").systemPrompt).toMatch(/do not implement|no code/i);
  });

  it("do not promise the researcher web access it does not have", () => {
    const prompt = role("researcher").systemPrompt;
    expect(prompt).toMatch(/no web access/i);
    expect(prompt).not.toMatch(/you can (browse|search the web|fetch)/i);
  });

  it("tell the verifier it changes nothing", () => {
    const prompt = role("verifier").systemPrompt;
    expect(prompt).toMatch(/change nothing/i);
    expect(role("verifier").excludeTools).toContain("edit");
    expect(role("verifier").excludeTools).toContain("write");
  });

  it("tell the coder to stay in scope and run the tests", () => {
    const prompt = role("coder").systemPrompt;
    expect(prompt).toMatch(/exactly the task/i);
    expect(prompt).toMatch(/run them|run the/i);
    expect(prompt).toMatch(/keep the diff/i);
  });

  it("embed the role catalogue in the orchestrator prompt, in sync with the registry", () => {
    expect(role("orchestrator").systemPrompt).toContain(roleCatalogue());
  });
});

describe("tool policy", () => {
  it("leaves the orchestrator without a --tools allowlist", () => {
    // `--tools` drops extension-registered custom tools, so using it here
    // would remove the one tool the role exists to call (plan Spike 2).
    expect(role("orchestrator").tools).toBeUndefined();
    expect(role("orchestrator").customTools).toContain(SPAWN_AGENT_TOOL);
  });

  it("uses plain --exclude-tools for the roles that have no custom tool", () => {
    for (const id of roleIds().filter((r) => r !== "orchestrator")) {
      expect(role(id).tools, id).toBeUndefined();
      expect(role(id).customTools, id).toBeUndefined();
    }
  });

  it("gives the coder pi's full default tool set", () => {
    // "full coding tools" means no allowlist and no exclusions: the coder is
    // the only role whose job is to write code, and restricting it buys nothing.
    expect(role("coder").excludeTools).toBeUndefined();
  });

  it("has at least one read-only role", () => {
    const readOnly = roleIds().filter((id) => isReadOnly(role(id)));
    expect(readOnly).toContain("verifier");
  });

  it("leaves bash available to the verifier — running tests is its whole job", () => {
    expect(role("verifier").excludeTools ?? []).not.toContain("bash");
  });
});

describe("worktree placement", () => {
  it("puts coders and the verifier in detached worktrees", () => {
    for (const id of ["coder", "verifier"] as RoleId[]) {
      expect(role(id).worktree, id).toBe("detached");
    }
  });

  it("keeps the single-writer roles in the shared base worktree", () => {
    for (const id of ["spec-writer", "researcher"] as RoleId[]) {
      expect(role(id).worktree, id).toBe("shared");
    }
  });

  it("merges back only the roles that work on their own branch", () => {
    // A shared-worktree role has no branch to merge, and the verifier's
    // detached worktree is throwaway — its result is the report.
    for (const id of roleIds()) {
      if (role(id).worktree === "detached") {
        expect(role(id).mergeBack, id).toBe(id === "coder");
      } else {
        expect(role(id).mergeBack, id).toBe(false);
      }
    }
  });
});

describe("getRole", () => {
  it("resolves a known id", () => {
    expect(getRole("coder")?.id).toBe("coder");
  });

  it("returns undefined rather than throwing on unknown input", () => {
    // Everything here arrives from outside the type system: the spawn_agent
    // argument, an env var, a Discord command.
    const junk: unknown[] = [
      "",
      "ORCHESTRATOR",
      "Coder",
      " coder",
      "coder ",
      "nope",
      "spawn_agent",
      null,
      undefined,
      42,
      {},
      { role: "coder" },
      ["coder"],
      true,
    ];
    for (const value of junk) {
      expect(getRole(value), JSON.stringify(value) ?? String(value)).toBeUndefined();
    }
  });

  it("does not resolve inherited object properties", () => {
    // `ROLES[id]` on its own would hand back Object.prototype methods.
    expect(getRole("toString")).toBeUndefined();
    expect(getRole("constructor")).toBeUndefined();
    expect(getRole("__proto__")).toBeUndefined();
  });
});

describe("spawnableRoleIds", () => {
  it("is exactly the four specialist roles", () => {
    expect(spawnableRoleIds()).toEqual(["spec-writer", "researcher", "coder", "verifier"]);
  });

  it("never offers the orchestrator or the reviewer", () => {
    // orchestrator: a spawnable orchestrator fans out forever.
    // reviewer: phase 2.3 drives it from GitHub events, not from spawn_agent.
    expect(spawnableRoleIds()).not.toContain("orchestrator");
    expect(spawnableRoleIds()).not.toContain("reviewer");
  });

  it("excludes exactly what the orchestrator prompt advertises", () => {
    for (const id of roleIds()) {
      const advertised = roleCatalogue().includes(id);
      expect(advertised, id).toBe(spawnableRoleIds().includes(id));
    }
  });
});

describe("roleCatalogue", () => {
  it("names every spawnable role, one line each", () => {
    const lines = roleCatalogue().split("\n");
    expect(lines).toHaveLength(spawnableRoleIds().length);
    for (const id of spawnableRoleIds()) {
      expect(roleCatalogue()).toContain(id);
    }
  });

  it("does not mention the roles the orchestrator may not spawn", () => {
    // Offering a role it cannot spawn only produces a rejected tool call.
    expect(roleCatalogue()).not.toContain("orchestrator");
    expect(roleCatalogue()).not.toContain("reviewer");
  });

  it("carries each role's charter, so the two cannot drift apart", () => {
    for (const id of spawnableRoleIds()) {
      expect(roleCatalogue()).toContain(role(id).charter);
    }
  });
});

describe("turn caps and output expectations", () => {
  it("caps turns on every spawnable role", () => {
    for (const id of spawnableRoleIds()) {
      const maxTurns = role(id).maxTurns;
      expect(typeof maxTurns, id).toBe("number");
      expect(maxTurns as number, id).toBeGreaterThan(0);
    }
  });

  it("expects files back only from the roles that produce them", () => {
    expect(role("spec-writer").writesWork).toBe(true);
    expect(role("researcher").writesWork).toBe(true);
    expect(role("coder").writesWork).toBe(true);
    // The orchestrator has no write tool; the verifier is read-only on purpose.
    expect(role("orchestrator").writesWork).toBeFalsy();
    expect(role("verifier").writesWork).toBe(false);
  });
});
