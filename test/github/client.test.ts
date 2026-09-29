import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { github } from "../../src/github/client.js";

/**
 * The Octokit instance is memoized module-side and built from config.github.token(),
 * so the fake keeps a mutable `api` object as its `rest` for the whole file.
 */
const h = vi.hoisted(() => ({
  api: {
    pulls: { create: vi.fn(), get: vi.fn(), createReviewComment: vi.fn(), createReview: vi.fn() },
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

/**
 * Phase 2.3 — posting reviews.
 *
 * These are payload-shape tests, and the shapes are the contract with GitHub
 * rather than with our own code: `side`, `commit_id` and `line` are what decide
 * whether a comment lands on the line the reviewer meant, and none of it is
 * checkable without an API call to look at.
 */
describe("github.getPullRequest", () => {
  it("maps the fields the reviewer decides on", async () => {
    h.api.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        state: "open",
        draft: false,
        head: { sha: SHA },
        html_url: "https://github.com/acme/widgets/pull/7",
      },
    });

    const pr = await github.getPullRequest(7);

    expect(pr).toEqual({
      number: 7,
      state: "open",
      draft: false,
      headSha: SHA,
      htmlUrl: "https://github.com/acme/widgets/pull/7",
    });
    expect(h.api.pulls.get).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 7,
    });
  });

  /**
   * `draft` is `undefined` on some API responses rather than `false`. Left as
   * undefined it would fail a `=== false` comparison and every PR would look like a
   * draft, which silences the reviewer entirely.
   */
  it("reads a missing draft flag as not a draft", async () => {
    h.api.pulls.get.mockResolvedValue({
      data: { number: 7, state: "open", head: { sha: SHA }, html_url: "u" },
    });

    await expect(github.getPullRequest(7)).resolves.toMatchObject({ draft: false });
  });
});

describe("github.postLineComment", () => {
  it("posts at the reviewed commit, on the right-hand side of the file", async () => {
    h.api.pulls.createReviewComment.mockResolvedValue({ data: { html_url: "c" } });

    await github.postLineComment(7, {
      path: "src/greet.js",
      line: 12,
      body: "name is never validated",
      commitId: SHA,
    });

    expect(h.api.pulls.createReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 7,
      body: "name is never validated",
      path: "src/greet.js",
      commit_id: SHA,
      line: 12,
      side: "RIGHT",
    });
  });

  /**
   * `side: RIGHT` is not a default to rely on. On the LEFT, `line` counts against
   * the base version of the file — so a comment would silently attach to a line
   * that is not the one the reviewer read, in a way no reader can detect.
   */
  it("names side explicitly rather than trusting the API default", async () => {
    h.api.pulls.createReviewComment.mockResolvedValue({ data: { html_url: "c" } });

    await github.postLineComment(7, { path: "a.js", line: 1, body: "b", commitId: SHA });

    const call = h.api.pulls.createReviewComment.mock.calls[0][0];
    expect(call.side).toBe("RIGHT");
  });

  it("returns the comment url", async () => {
    h.api.pulls.createReviewComment.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/pull/7#discussion_r1" },
    });

    await expect(
      github.postLineComment(7, { path: "a.js", line: 1, body: "b", commitId: SHA })
    ).resolves.toBe("https://github.com/o/r/pull/7#discussion_r1");
  });
});

describe("github.postReview", () => {
  /**
   * `event: COMMENT` and nothing else. APPROVE would be the factory signing off on
   * its own work, and REQUEST_CHANGES would block a merge the human has to decide
   * on — neither is a review, and the role charter says the reviewer cannot do
   * either.
   */
  it("posts a COMMENT review, never an approval or a change request", async () => {
    h.api.pulls.createReview.mockResolvedValue({ data: { html_url: "r" } });

    await github.postReview(7, "Two findings, both about error paths.");

    expect(h.api.pulls.createReview).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 7,
      event: "COMMENT",
      body: "Two findings, both about error paths.",
    });
    const call = h.api.pulls.createReview.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("comments");
  });

  it("returns the review url", async () => {
    h.api.pulls.createReview.mockResolvedValue({ data: { html_url: "https://x/review" } });

    await expect(github.postReview(7, "b")).resolves.toBe("https://x/review");
  });
});
