/**
 * The deploy-time knob that decides whether a graph can run at all
 * (`deploy/configure-env.sh`, open-issues #4).
 *
 * `setup-factory.sh` cannot be tested without provisioning a container, but the
 * one thing it writes that changes behaviour — the spawn channel's bind address
 * — was factored into a function precisely so it could be run against a temp
 * file here. Everything below execs real bash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../src/config.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "../../deploy/configure-env.sh");
const SETUP = path.join(HERE, "../../deploy/setup-factory.sh");

/**
 * The env file a fresh VPS actually gets: `setup-factory.sh` installs
 * `.env.example`, so this reads that file rather than a hand-copy of it. A copy
 * would let a rename in `.env.example` pass every test here while the deployed
 * default stayed commented-out and unreachable — which is the exact bug this
 * script exists to prevent.
 */
function exampleEnv(): string {
  return `${fs.readFileSync(path.join(HERE, "../../.env.example"), "utf8")}\n`;
}

function configure(envFile: string, os: string): { code: number; out: string; err: string } {
  const command =
    `source ${JSON.stringify(SCRIPT)} && ` +
    `configure_factory_env ${JSON.stringify(envFile)} ${JSON.stringify(os)}`;
  try {
    const out = execFileSync("bash", ["-c", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failed.status ?? 1,
      out: failed.stdout ?? "",
      err: failed.stderr ?? "",
    };
  }
}

/** Live (not commented) assignments for one variable, in file order. */
function liveLines(envFile: string, name = "FACTORY_IPC_BIND"): string[] {
  return fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => new RegExp(`^\\s*${name}=`).test(line));
}

let dir: string;
let envFile: string;

beforeEach(() => {
  dir = makeTempDir();
  envFile = path.join(dir, "factory.env");
  fs.writeFileSync(envFile, exampleEnv());
});

afterEach(() => {
  removeTempDir(dir);
  vi.unstubAllEnvs();
});

describe("configure_factory_env", () => {
  it("writes a bind a container can reach on a Linux host", () => {
    const result = configure(envFile, "Linux");

    expect(result.code).toBe(0);
    expect(liveLines(envFile)).toEqual(["FACTORY_IPC_BIND=0.0.0.0"]);
    expect(result.out).toContain("Linux host");
  });

  /**
   * The assertion that makes this more than a text match: the name written into
   * the env file is the one `src/config.ts` actually reads. A typo here deploys a
   * VPS that still cannot spawn, and no test would notice anything else.
   */
  it("writes a variable the factory really reads", () => {
    configure(envFile, "Linux");
    const [line] = liveLines(envFile);
    const [name, value] = line.split("=");
    vi.stubEnv(name, value);

    expect(config.factory.ipcBind).toBe("0.0.0.0");
  });

  it("comments the exposure it is accepting, at the line where it writes it", () => {
    configure(envFile, "Linux");
    const written = fs.readFileSync(envFile, "utf8");
    const block = written.slice(written.indexOf("# --- agent graph + PR review spawn channel"));

    // Why the default is wrong / what the widened port is gated by / what to do
    // about it at the firewall.
    expect(block).toContain("docker bridge");
    expect(block).toMatch(/per-run token|token gates/i);
    expect(block).toMatch(/firewall/);
    expect(block).toContain("FACTORY_IPC_BIND=0.0.0.0");
  });

  /**
   * The half open-issues #4 missed. Widening the bind is useless if the name the
   * container dials does not resolve, and Docker Engine on Linux never defines
   * `host.docker.internal` — so this second line is the other half of the same
   * one requirement, and it has to be written by the same install step.
   */
  it("writes the add-host mapping that makes the hostname resolve at all", () => {
    configure(envFile, "Linux");

    const written = fs.readFileSync(envFile, "utf8");
    const block = written.slice(written.indexOf("# Docker Engine on Linux"));

    expect(block).toContain("does not define host.docker.internal");
    expect(block).toContain("FACTORY_IPC_ADD_HOST=host.docker.internal:host-gateway");
    // And the name written is the name the host actually reads — the same
    // parse-then-stub move as the bind test, because a wrong variable name here
    // deploys a host that still cannot resolve anything.
    const [addHostLine] = liveLines(envFile, "FACTORY_IPC_ADD_HOST");
    const [name, value] = addHostLine.split("=");
    vi.stubEnv(name, value);

    expect(config.factory.ipcAddHost).toBe("host.docker.internal:host-gateway");
  });

  /**
   * The two knobs are independent, because an operator may have set only one.
   * Refusing to touch a file that has a hand-written bind would leave a Linux host
   * that resolved nothing; refusing both because one was set is the bug this pins.
   */
  it("still writes the mapping when the operator set only the bind by hand", () => {
    fs.writeFileSync(envFile, "FACTORY_IPC_BIND=172.17.0.1\n");

    const result = configure(envFile, "Linux");

    expect(result.out).toContain("FACTORY_IPC_BIND already set");
    expect(liveLines(envFile)).toEqual(["FACTORY_IPC_BIND=172.17.0.1"]);
    expect(liveLines(envFile, "FACTORY_IPC_ADD_HOST")).toHaveLength(1);
  });

  it("leaves a non-Linux host exactly as it found it", () => {
    const before = fs.readFileSync(envFile, "utf8");

    const result = configure(envFile, "Darwin");

    expect(result.code).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(before);
    expect(liveLines(envFile)).toEqual([]);
  });

  it("keeps values the operator already set", () => {
    const before = "FACTORY_IPC_BIND=172.17.0.1\nFACTORY_IPC_ADD_HOST=custom\n";
    fs.writeFileSync(envFile, before);

    const result = configure(envFile, "Linux");

    expect(result.code).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(before);
    expect(result.out).toContain("FACTORY_IPC_BIND already set");
    expect(result.out).toContain("FACTORY_IPC_ADD_HOST already set");
    // And the summary line stays quiet when nothing was written: an install log
    // that claims it configured the host when it configured nothing is a lie.
    expect(result.out).not.toContain("wrote FACTORY_IPC_BIND");
  });

  it("is idempotent — a re-run does not stack a second listener on the file", () => {
    configure(envFile, "Linux");
    const afterFirst = fs.readFileSync(envFile, "utf8");

    configure(envFile, "Linux");

    expect(liveLines(envFile)).toHaveLength(1);
    expect(liveLines(envFile, "FACTORY_IPC_ADD_HOST")).toHaveLength(1);
    expect(fs.readFileSync(envFile, "utf8")).toBe(afterFirst);
  });

  /**
   * The commented line in `.env.example` is documentation. If it counted as a
   * setting, every fresh VPS would keep the unreachable default and this script
   * would report that everything was already fine.
   */
  it("does not mistake the commented example for a setting", () => {
    configure(envFile, "Linux");

    expect(liveLines(envFile)).toEqual(["FACTORY_IPC_BIND=0.0.0.0"]);
    // the documentation lines stay where they are
    expect(fs.readFileSync(envFile, "utf8")).toContain("# FACTORY_IPC_BIND=127.0.0.1");
    expect(fs.readFileSync(envFile, "utf8")).toContain("# FACTORY_IPC_ADD_HOST=");
  });

  it("refuses rather than inventing an env file", () => {
    const missing = path.join(dir, "nope.env");

    const result = configure(missing, "Linux");

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("nope.env");
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("refuses an empty path too", () => {
    expect(configure("", "Linux").code).not.toBe(0);
  });

  describe("wired into the install", () => {
    const setup = fs.readFileSync(SETUP, "utf8");

    it("is sourced and called by setup-factory.sh", () => {
      expect(setup).toContain("source /home/pi/factory/deploy/configure-env.sh");
      expect(setup).toContain('configure_factory_env "$ENV_FILE" "$(uname -s)"');
    });

    it("runs after the env file exists, not before", () => {
      const installed = setup.indexOf('install -m 600 /home/pi/factory/.env.example "$ENV_FILE"');
      const configured = setup.indexOf("configure_factory_env");

      expect(installed).toBeGreaterThan(-1);
      expect(configured).toBeGreaterThan(installed);
    });
  });
});
