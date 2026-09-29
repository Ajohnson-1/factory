import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_ENV } from "../../src/agents/spawn.js";
import { IPC_PROTOCOL_VERSION } from "../../src/agents/ipc.js";

/**
 * The extension is baked into the agent image and cannot import from `src/`, so
 * the two sides of the channel duplicate the same names by hand. This test is
 * what stops that duplication from rotting: rename a constant on one side and
 * this fails instead of every graph run silently losing its spawn tool.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "../../deploy/docker/extensions/spawn-agent.ts");

const source = fs.readFileSync(EXTENSION, "utf8");

describe("spawn-agent extension", () => {
  it("exists where the Dockerfile copies it from", () => {
    expect(fs.existsSync(EXTENSION)).toBe(true);
    const dockerfile = fs.readFileSync(
      path.join(HERE, "../../deploy/docker/factory-agent.Dockerfile"),
      "utf8"
    );
    // The image copies the whole directory, so a new extension is in the image by
    // default — the failure this guards against is a file that exists in the repo,
    // passes every typecheck, and is silently absent from the container.
    expect(dockerfile).toContain("COPY extensions/ /opt/factory/extensions/");
  });

  // A mismatch here is the silent kind: pi would start, the model would see the
  // tool, and the request would go out with an undefined token or port.
  it("reads every env name the host actually sets", () => {
    for (const [key, name] of Object.entries(IPC_ENV)) {
      expect(source, `FACTORY_* name for ${key}`).toContain(`process.env.${name}`);
    }
  });

  it("names the tool exactly what the role registry advertises", async () => {
    const { SPAWN_AGENT_TOOL } = await import("../../src/agents/roles.js");

    expect(source).toContain(`name: "${SPAWN_AGENT_TOOL}"`);
  });

  it("sends the protocol version the host parses", () => {
    expect(source).toContain(`const PROTOCOL_VERSION = ${IPC_PROTOCOL_VERSION};`);
  });

  it("keeps the wire field names the host's parser requires", () => {
    for (const field of ["t: \"spawn\"", "token:", "role:", "task:"]) {
      expect(source, field).toContain(field);
    }
  });

  it("applies the tool set at session_start, never while loading", () => {
    // setActiveTools() during loading aborts pi's startup outright
    // ("Extension runtime not initialized"), so this ordering is load-bearing.
    const sessionStart = source.indexOf('pi.on("session_start"');
    const setActive = source.indexOf("pi.setActiveTools(");

    expect(sessionStart).toBeGreaterThan(-1);
    expect(setActive).toBeGreaterThan(sessionStart);
    expect(source.slice(0, sessionStart)).not.toContain("pi.setActiveTools(");
  });

  it("never writes to stdout, which is pi's event stream in JSON mode", () => {
    expect(source).not.toMatch(/(^|[^.\w])console\.log\s*\(/m);
    expect(source).not.toMatch(/process\.stdout\.write/);
    expect(source).toContain("process.stderr.write");
  });

  it("is registered through pi.registerTool", () => {
    expect(source).toContain("pi.registerTool(");
  });

  /**
   * open-issues #4: on a Linux host the default bind makes this channel
   * unreachable, so the container's failure message has to name the variable the
   * operator can actually change. Asserted against the source because the
   * extension resolves pi's imports from inside the image and cannot be imported
   * here — the same reason the rest of this file reads the file as text.
   */
  it("routes both channel failures through the message that names FACTORY_IPC_BIND", () => {
    const faults = source.match(/channelFault\(/g) ?? [];

    // The definition plus both reachability paths: refused, and never answered.
    expect(faults).toHaveLength(3);
    expect(source).toContain("FACTORY_IPC_BIND");
    expect(source).not.toMatch(/reject\(new Error\(`the factory host did not answer/);
    expect(source).not.toMatch(/reject\(new Error\(`spawn channel failed/);
  });
});

/**
 * The reviewer's extension (phase 2.3) — same channel, same duplicated names, and
 * the same way to rot: it lives in the image and `src/agents/ipc.ts` does not.
 *
 * Beyond the drift checks, this block asserts the one thing that makes the two
 * containers different rather than merely similar: a reviewer's extension must not
 * read the names that would let it plan work, because the reviewer is not
 * spawnable and a channel that answers both request types to both roles would make
 * that a lie.
 */
describe("post-review extension", () => {
  const REVIEW_EXTENSION = path.join(HERE, "../../deploy/docker/extensions/post-review.ts");
  const reviewSource = fs.readFileSync(REVIEW_EXTENSION, "utf8");

  it("exists in the directory the image copies", () => {
    expect(fs.existsSync(REVIEW_EXTENSION)).toBe(true);
  });

  it("reads the shared channel env names the host sets", () => {
    for (const name of [IPC_ENV.host, IPC_ENV.port, IPC_ENV.token, IPC_ENV.activeTools]) {
      expect(reviewSource, name).toContain(`process.env.${name}`);
    }
  });

  /**
   * The negative half of the check above, and the reason it is not simply shared
   * code: if the reviewer's extension ever reads the spawn-only names, something has
   * started wiring a spawn tool into a review container.
   */
  it("cannot be told what to spawn, because it never reads the spawn names", () => {
    for (const name of [IPC_ENV.spawnable, IPC_ENV.spawnTimeout]) {
      expect(reviewSource, name).not.toContain(`process.env.${name}`);
    }
  });

  it("names the tool exactly what the role registry advertises", async () => {
    const { POST_REVIEW_TOOL } = await import("../../src/agents/roles.js");

    expect(reviewSource).toContain(`name: "${POST_REVIEW_TOOL}"`);
    // And the role's data-driven tool set agrees with it, which is what actually
    // puts the tool on the model's list at session_start.
    const { ROLES } = await import("../../src/agents/roles.js");
    expect(ROLES.reviewer.activeTools).toContain(POST_REVIEW_TOOL);
  });

  it("sends `t: review` and the fields the host's review parser requires", () => {
    expect(reviewSource).toContain(`const PROTOCOL_VERSION = ${IPC_PROTOCOL_VERSION};`);
    for (const field of ['t: "review"', "token:", "body:", "path:", "line:"]) {
      expect(reviewSource, field).toContain(field);
    }
  });

  it("never puts a pull request number on the wire — the host owns that", () => {
    // An agent-chosen PR number would let a reviewed container comment on any PR
    // the orchestrator's token can reach. The host knows which PR it started this
    // container for, and says so.
    expect(reviewSource).not.toMatch(/pull_request|pr_number|prNumber|pullNumber/);
  });

  it("applies the tool set at session_start, never while loading", () => {
    const sessionStart = reviewSource.indexOf('pi.on("session_start"');
    const setActive = reviewSource.indexOf("pi.setActiveTools(");

    expect(sessionStart).toBeGreaterThan(-1);
    expect(setActive).toBeGreaterThan(sessionStart);
    expect(reviewSource.slice(0, sessionStart)).not.toContain("pi.setActiveTools(");
  });

  it("keeps every diagnostic off stdout, which is pi's event stream", () => {
    expect(reviewSource).not.toMatch(/(^|[^.\w])console\.log\s*\(/m);
    expect(reviewSource).not.toMatch(/process\.stdout\.write/);
    expect(reviewSource).toContain("process.stderr.write");
  });

  /**
   * Both extensions diagnose the same fault, and the handoff's pi facts make it the
   * most likely first failure on a real Linux host. If the wording drifts, an
   * operator reading a reviewer's error gets a different instruction than one
   * reading an orchestrator's, from the same cause.
   */
  it("routes its channel faults through the same BIND hint the orchestrator's say", () => {
    const spawn = fs.readFileSync(EXTENSION, "utf8");
    const hint = /const BIND_HINT =\n((?:.|\n)*?);\n/;
    const inSpawn = spawn.match(hint)?.[1];
    const inReview = reviewSource.match(hint)?.[1];

    expect(inSpawn, "spawn-agent.ts has no BIND_HINT").toBeTruthy();
    expect(inReview, "post-review.ts has no BIND_HINT").toBeTruthy();
    expect(inReview).toBe(inSpawn);
    expect(reviewSource.match(/channelFault\(/g)).toHaveLength(3);
  });
});
