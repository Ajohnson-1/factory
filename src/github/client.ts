import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

let octokit: Octokit | undefined;

function client(): Octokit {
  // Memoized, which is why the base URL is read here rather than per call: an
  // Octokit's root is fixed when it is built.
  if (!octokit) {
    octokit = new Octokit({
      auth: config.github.token(),
      baseUrl: config.github.apiBaseUrl(),
    });
  }
  return octokit;
}

/** What the factory needs to know about a pull request before commenting on it. */
export interface PullRequestState {
  number: number;
  state: string;
  draft: boolean;
  /** The commit the PR points at right now — compared against the reviewed SHA. */
  headSha: string;
  htmlUrl: string;
}

export const github = {
  /**
   * Read one PR's state. Called immediately before posting, because a review
   * takes minutes and a closed PR must not receive one — and because the head may
   * have moved, in which case the lines the reviewer saw are not the lines this
   * would comment on.
   */
  async getPullRequest(number: number): Promise<PullRequestState> {
    const { data: pr } = await client().rest.pulls.get({
      owner: config.github.owner(),
      repo: config.github.repo(),
      pull_number: number,
    });
    return {
      number: pr.number,
      state: pr.state,
      draft: pr.draft ?? false,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
    };
  },
  /**
   * Post one line comment on a PR.
   *
   * `commit_id` is the SHA the reviewer actually had checked out, not "the head":
   * GitHub will attach a comment to a commit that is no longer current, and that
   * is the difference between a finding a reader can locate and one they cannot.
   * `side: RIGHT` is the new version of the file, which is what a line number in
   * a diff means to the person who has to act on it.
   */
  async postLineComment(
    number: number,
    finding: { path: string; line: number; body: string; commitId: string }
  ): Promise<string> {
    const { data: comment } = await client().rest.pulls.createReviewComment({
      owner: config.github.owner(),
      repo: config.github.repo(),
      pull_number: number,
      body: finding.body,
      path: finding.path,
      commit_id: finding.commitId,
      line: finding.line,
      side: "RIGHT",
    });
    return comment.html_url;
  },
  /**
   * Post the review summary. `event: COMMENT` and nothing else: the factory
   * reviews, it does not approve. `pulls.createReview` with no `comments` is a
   * body-only review, which is what a reviewer that posts as it goes ends with.
   */
  async postReview(number: number, body: string): Promise<string> {
    const { data: review } = await client().rest.pulls.createReview({
      owner: config.github.owner(),
      repo: config.github.repo(),
      pull_number: number,
      event: "COMMENT",
      body,
    });
    return review.html_url;
  },
  async createPR(branch: string, title: string, body: string): Promise<string> {
    const { data: pr } = await client().rest.pulls.create({
      owner: config.github.owner(),
      repo: config.github.repo(),
      head: branch,
      base: "main",
      title,
      body,
    });
    return pr.html_url;
  },
  async ciStatus(branch: string): Promise<"pending" | "passed" | "failed"> {
    const { data: commits } = await client().rest.repos.listCommits({
      owner: config.github.owner(),
      repo: config.github.repo(),
      sha: branch,
      perPage: 1,
    });
    const sha = commits[0]?.sha;
    if (!sha) return "pending";
    const { data: statuses } = await client().rest.repos.getCombinedStatusForRef({
      owner: config.github.owner(),
      repo: config.github.repo(),
      ref: sha,
    });
    if (statuses.state === "success") return "passed";
    if (statuses.state === "failure") return "failed";
    return "pending";
  },
  /**
   * Poll CI until passed/failed/timeout. Note: a branch whose head commit has no
   * statuses at all (repo without CI, or checks that have not started) reports
   * `pending`, so it polls until `timeoutMs` elapses. Behaviour fix deferred —
   * see "Found while testing" in plan/2.0-testing.md.
   */
  async waitForCI(
    branch: string,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<"passed" | "failed" | "timeout"> {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    const pollMs = opts.pollMs ?? 30_000;
    const start = Date.now();
    for (;;) {
      // via `github`, not `this`, so the method survives being passed around bare
      const status = await github.ciStatus(branch);
      if (status !== "pending") return status;
      if (Date.now() - start > timeoutMs) return "timeout";
      await new Promise((r) => setTimeout(r, pollMs));
    }
  },
};
