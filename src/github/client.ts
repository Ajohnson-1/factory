import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

let octokit: Octokit | undefined;

function client(): Octokit {
  if (!octokit) octokit = new Octokit({ auth: config.github.token() });
  return octokit;
}

export const github = {
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
