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
    expect(dockerfile).toContain("COPY extensions/spawn-agent.ts");
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
