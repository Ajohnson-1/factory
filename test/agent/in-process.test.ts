import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// The pi SDK must never load for real: fake it at the module boundary so
// importing in-process.ts costs nothing and no model is ever contacted.
const sdk = vi.hoisted(() => {
  const session = {
    prompt: vi.fn(async (_prompt: string): Promise<void> => {}),
    subscribe: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    session,
    createRuntime: vi.fn(async (): Promise<{ id: string }> => ({ id: "runtime" })),
    inMemory: vi.fn((_dir: string) => ({ id: "smgr" })),
    createSession: vi.fn(
      async (_opts: { cwd: string; modelRuntime: unknown; sessionManager: unknown }) => ({
        session,
      })
    ),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: sdk.createRuntime },
  SessionManager: { inMemory: sdk.inMemory },
  createAgentSession: sdk.createSession,
}));

import { runAgentProcess } from "../../src/agent/in-process.js";

const DIR = "/tmp/wt-card-1";

beforeEach(() => {
  // restoreMocks resets spies between tests; re-arm the hoisted fakes too
  sdk.session.prompt.mockReset().mockResolvedValue(undefined);
  sdk.session.subscribe.mockReset();
  sdk.session.dispose.mockReset();
  sdk.createRuntime.mockReset().mockResolvedValue({ id: "runtime" });
  sdk.inMemory.mockReset().mockReturnValue({ id: "smgr" });
  sdk.createSession.mockReset().mockResolvedValue({ session: sdk.session });
});

/** The subscribe handler the runtime registered on the fake session. */
function registeredHandler(): ((event: unknown) => void) | undefined {
  return sdk.session.subscribe.mock.calls[0]?.[0];
}

describe("runAgentProcess (dev-only in-process runtime)", () => {
  it("opens a pi session in the card's directory", async () => {
    await runAgentProcess({ dir: DIR, prompt: "do it" });

    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.createSession.mock.calls[0]?.[0]).toMatchObject({ cwd: DIR });
  });

  it("keeps the session in memory so nothing is written to the repo", async () => {
    await runAgentProcess({ dir: DIR, prompt: "do it" });

    expect(sdk.inMemory).toHaveBeenCalledWith(DIR);
    expect(
      sdk.createSession.mock.calls[0]?.[0]
    ).toMatchObject({ sessionManager: { id: "smgr" } });
  });

  it("sends the prompt to the session", async () => {
    await runAgentProcess({ dir: DIR, prompt: "add greet()" });

    expect(sdk.session.prompt).toHaveBeenCalledTimes(1);
    expect(sdk.session.prompt.mock.calls[0]?.[0]).toBe("add greet()");
  });

  it("forwards tool starts to onTool", async () => {
    const onTool = vi.fn();

    await runAgentProcess({ dir: DIR, prompt: "do it", onTool });
    registeredHandler()?.({ type: "tool_execution_start", toolName: "bash" });

    expect(onTool).toHaveBeenCalledWith("bash");
  });

  it("ignores session events that are not tool starts", async () => {
    const onTool: Mock = vi.fn();

    await runAgentProcess({ dir: DIR, prompt: "do it", onTool });
    const handler = registeredHandler();
    handler?.({ type: "message_update" });
    handler?.({ type: "tool_execution_end", toolName: "bash" });

    expect(onTool).not.toHaveBeenCalled();
  });

  it("disposes the session after the run", async () => {
    await runAgentProcess({ dir: DIR, prompt: "do it" });

    expect(sdk.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("propagates a prompt failure", async () => {
    sdk.session.prompt.mockRejectedValueOnce(new Error("model exploded"));

    await expect(runAgentProcess({ dir: DIR, prompt: "do it" })).rejects.toThrow(
      "model exploded"
    );
  });

  it("ignores gitDir — the host filesystem is already in reach here", async () => {
    await runAgentProcess({ dir: DIR, gitDir: "/somewhere/.git", prompt: "do it" });

    expect(sdk.createSession.mock.calls[0]?.[0]).not.toHaveProperty("gitDir");
  });

  // Last: needs a pristine module so the memo starts empty (module-level
  // `modelRuntime`, and vi.resetModules keeps the pi mock registered).
  it("reuses one model runtime across two runs", async () => {
    vi.resetModules();
    const fresh = await import("../../src/agent/in-process.js");

    await fresh.runAgentProcess({ dir: DIR, prompt: "one" });
    await fresh.runAgentProcess({ dir: DIR, prompt: "two" });

    expect(sdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(2);
  });
});
