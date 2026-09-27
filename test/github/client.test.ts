import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { github } from "../../src/github/client.js";

/**
 * The Octokit instance is memoized module-side and built from config.github.token(),
 * so the fake keeps a mutable `api` object as its `rest` for the whole file.
 */
const h = vi.hoisted(() => ({
  api: {
    pulls: { create: vi.fn() },
    repos: { listCommits: vi.fn(), getCombinedStatusForRef: vi.fn() },
  },
  authTokens: [] as string[],
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = h.api;
    constructor(opts: { auth: string }) {
      h.authTokens.push(opts.auth);
    }
  },
}));

const OWNER = "acme";
const REPO = "widgets";
const BRANCH = "factory/card-1";
const SHA = "abc123";

/** One commit on the branch, with the given combined status state. */
function commitWith(state: string): void {
  h.api.repos.listCommits.mockResolvedValue({ data: [{ sha: SHA }] });
  h.api.repos.getCombinedStatusForRef.mockResolvedValue({
    data: { state, statuses: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("GITHUB_OWNER", OWNER);
  vi.stubEnv("GITHUB_REPO", REPO);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("github.createPR", () => {
  it("returns the html_url of the created pull request", async () => {
    h.api.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/acme/widgets/pull/7" },
    });

    await expect(github.createPR(BRANCH, "Title", "Body")).resolves.toBe(
      "https://github.com/acme/widgets/pull/7"
    );
  });

  it("creates the PR against main for the given branch", async () => {
    h.api.pulls.create.mockResolvedValue({ data: { html_url: "u" } });

    await github.createPR(BRANCH, "Title", "Body");

    expect(h.api.pulls.create).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      head: BRANCH,
      base: "main",
      title: "Title",
      body: "Body",
    });
  });

  it("authenticates with GITHUB_TOKEN", async () => {
    h.api.pulls.create.mockResolvedValue({ data: { html_url: "u" } });

    await github.createPR(BRANCH, "Title", "Body");

    expect(h.authTokens).toContain("gh-token");
  });
});

describe("github.ciStatus", () => {
  it("resolves the branch head sha with a single-commit request", async () => {
    commitWith("success");

    await github.ciStatus(BRANCH);

    expect(h.api.repos.listCommits).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      sha: BRANCH,
      perPage: 1,
    });
  });

  it("checks the combined status for the resolved sha", async () => {
    commitWith("success");

    await github.ciStatus(BRANCH);

    expect(h.api.repos.getCombinedStatusForRef).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      ref: SHA,
    });
  });

  it("maps a success state to passed", async () => {
    commitWith("success");
    await expect(github.ciStatus(BRANCH)).resolves.toBe("passed");
  });

  it("maps a failure state to failed", async () => {
    commitWith("failure");
    await expect(github.ciStatus(BRANCH)).resolves.toBe("failed");
  });

  it("maps a pending state to pending", async () => {
    commitWith("pending");
    await expect(github.ciStatus(BRANCH)).resolves.toBe("pending");
  });

  it("maps any other state to pending", async () => {
    commitWith("error");
    await expect(github.ciStatus(BRANCH)).resolves.toBe("pending");
  });

  it("is pending without asking for a status when the branch has no commits", async () => {
    h.api.repos.listCommits.mockResolvedValue({ data: [] });

    await expect(github.ciStatus(BRANCH)).resolves.toBe("pending");
    expect(h.api.repos.getCombinedStatusForRef).not.toHaveBeenCalled();
  });
});

describe("github.waitForCI", () => {
  it("returns passed as soon as the status stops being pending", async () => {
    vi.useFakeTimers();
    h.api.repos.listCommits
      .mockResolvedValueOnce({ data: [{ sha: SHA }] })
      .mockResolvedValue({ data: [{ sha: SHA }] });
    h.api.repos.getCombinedStatusForRef
      .mockResolvedValueOnce({ data: { state: "pending" } })
      .mockResolvedValue({ data: { state: "success" } });

    const result = github.waitForCI(BRANCH, { pollMs: 5, timeoutMs: 10_000 });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe("passed");
    expect(h.api.repos.listCommits).toHaveBeenCalledTimes(2);
  });

  it("returns failed on the first poll without waiting", async () => {
    vi.useFakeTimers();
    commitWith("failure");

    await expect(
      github.waitForCI(BRANCH, { pollMs: 5, timeoutMs: 10_000 })
    ).resolves.toBe("failed");
    expect(h.api.repos.listCommits).toHaveBeenCalledTimes(1);
  });

  it("keeps working when detached from the github object", async () => {
    vi.useFakeTimers();
    commitWith("failure");
    const { waitForCI } = github;

    // regression: this used to call `this.ciStatus` and throw a TypeError
    await expect(
      waitForCI(BRANCH, { pollMs: 5, timeoutMs: 10_000 })
    ).resolves.toBe("failed");
  });

  it("returns timeout when the status never leaves pending", async () => {
    vi.useFakeTimers();
    commitWith("pending");

    const result = github.waitForCI(BRANCH, { pollMs: 10, timeoutMs: 50 });
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe("timeout");
  });

  it("gives up after the default 15 minute timeout", async () => {
    vi.useFakeTimers();
    commitWith("pending");

    const result = github.waitForCI(BRANCH);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe("timeout");
  });
});
