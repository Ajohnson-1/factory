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

/** The env file a fresh VPS gets: `.env.example` with its commented defaults. */
function exampleEnv(): string {
  return [
    "# Agent graphs (phase 2.2)",
    "# FACTORY_IPC_BIND=127.0.0.1   loopback works on Docker Desktop.",
    "# FACTORY_IPC_PORT=0           0 = let the OS pick.",
    "REPO_PATH=/home/pi/repos/app",
    "",
  ].join("\n");
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

/** Live (not commented) `FACTORY_IPC_BIND` assignments, in file order. */
function liveLines(envFile: string): string[] {
  return fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => /^\s*FACTORY_IPC_BIND=/.test(line));
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
    const block = written.slice(written.indexOf("# --- agent graph spawn channel"));

    // Why the default is wrong / what the widened port is gated by / what to do
    // about it at the firewall.
    expect(block).toContain("docker bridge");
    expect(block).toMatch(/per-run token|token gates/i);
    expect(block).toMatch(/firewall/);
    expect(block.trimEnd().endsWith("FACTORY_IPC_BIND=0.0.0.0")).toBe(true);
  });

  it("leaves a non-Linux host exactly as it found it", () => {
    const before = fs.readFileSync(envFile, "utf8");

    const result = configure(envFile, "Darwin");

    expect(result.code).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(before);
    expect(liveLines(envFile)).toEqual([]);
  });

  it("keeps a value the operator already set", () => {
    fs.writeFileSync(envFile, "FACTORY_IPC_BIND=172.17.0.1\n");

    const result = configure(envFile, "Linux");

    expect(result.code).toBe(0);
    expect(liveLines(envFile)).toEqual(["FACTORY_IPC_BIND=172.17.0.1"]);
    expect(result.out).toContain("already set");
  });

  it("is idempotent — a re-run does not stack a second listener on the file", () => {
    configure(envFile, "Linux");
    const afterFirst = fs.readFileSync(envFile, "utf8");

    configure(envFile, "Linux");

    expect(liveLines(envFile)).toHaveLength(1);
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
    // the documentation line stays where it is
    expect(fs.readFileSync(envFile, "utf8")).toContain(
      "# FACTORY_IPC_BIND=127.0.0.1"
    );
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
