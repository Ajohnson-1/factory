/**
 * Real-review smoke (phase 2.3) — the check that actually posts.
 *
 *   TEST_REVIEW=1 AGENT_MODEL=<provider/model-id> \
 *     FACTORY_AGENT_MODELS_FILE=$PWD/models.json npm run test:review-smoke
 *
 * Everything below runs against the real thing: a real temp git repo with a real
 * detached review worktree, a real `factory-agent` container running a real model,
 * the real in-container `post_review` extension reaching a real TCP IPC server, and
 * the real Octokit client making the real HTTP requests.
 *
 * What is *not* real is the far end of those HTTP requests: `GITHUB_API_BASE_URL`
 * points Octokit at a local sink that records what was posted. That seam exists
 * because the alternative — verifying the reviewer by having it comment on a real
 * repository — writes findings under a bot's name into whoever's issue tracker to
 * test a script. The sink still proves the only thing worth proving: that a
 * finding the model made inside a container arrived as a correctly shaped
 * `pulls/createReviewComment` call, at the reviewed commit, on the right-hand side
 * of the file.
 *
 * `plan/HANDOFF-2.3.md`'s lesson applies directly: 413 unit tests were green over
 * a bug that only this kind of run caught. A reviewer whose tool silently never
 * fires would look identical in every other check — the store row would still read
 * `posted`, because the fallback posts its final text.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/state/store.js";
import { reviewPr } from "../src/reviewer/reviewer.js";
import { commonGitDir } from "../src/worker/worktree.js";
import { makeGitRepo, type GitRepoFixture } from "../test/helpers/git.js";

const ENABLED = process.env.TEST_REVIEW === "1";
const MODEL = process.env.AGENT_MODEL || "";
const MODELS_FILE = process.env.FACTORY_AGENT_MODELS_FILE || "";
const IMAGE = process.env.AGENT_IMAGE || "factory-agent";
const CARD_ID = "smoke0001";
const PR_NUMBER = 42;
const OWNER = "factory-smoke";
const REPO = "widgets";

function skip(reason: string): never {
  console.log(`\n[review-smoke] SKIPPED — ${reason}\n`);
  console.log("  usage: TEST_REVIEW=1 AGENT_MODEL=<provider/model-id> \\");
  console.log("           FACTORY_AGENT_MODELS_FILE=$PWD/models.json \\");
  console.log("           npm run test:review-smoke");
  console.log("  (one line: a trailing space after a `\\` makes the next line's");
  console.log("   assignments unexported and the smoke self-skips silently)");
  process.exit(0);
}

if (!ENABLED) {
  skip("TEST_REVIEW is not 1 (this starts a container and spends a real model)");
}
if (!MODEL) skip("AGENT_MODEL is unset; the reviewer needs a model to run");

// ---------------------------------------------------------------------------
// Pre-flight: separate "the factory is broken" from "the model is not there".
// graph-smoke learned this the expensive way — a dead endpoint and a broken flow
// produce the same failure list.
// ---------------------------------------------------------------------------

/** The baseUrl pi will use, read out of the same models.json the container mounts. */
function endpoint(): string | undefined {
  if (!MODELS_FILE || !fs.existsSync(MODELS_FILE)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")) as {
      providers?: Record<string, { baseUrl?: string }>;
    };
    const providers = parsed.providers ?? {};
    const hinted = MODEL.split("/")[0];
    const key = providers[hinted]?.baseUrl
      ? hinted
      : Object.keys(providers).find((k) => providers[k]?.baseUrl);
    return key ? providers[key]?.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

async function preflight(): Promise<void> {
  // The extension is baked into the image, not mounted (a mounted one cannot
  // resolve pi's dependencies). A stale image means the reviewer has no tool at
  // all, and the model will simply describe its findings instead of posting them.
  try {
    execFileSync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "ls",
      IMAGE,
      "-l",
      "/opt/factory/extensions/post-review.ts",
    ]);
  } catch {
    skip(
      `${IMAGE} has no /opt/factory/extensions/post-review.ts — rebuild it with \`bash deploy/docker/build.sh\``
    );
  }

  const base = endpoint();
  if (!base) {
    console.log(`[pre-flight] no baseUrl for ${MODEL} in ${MODELS_FILE || "(no models.json)"}; not probing`);
    return;
  }
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    console.log(`[pre-flight] model endpoint answers at ${base}`);
  } catch (err) {
    skip(
      `the model endpoint at ${base} is unreachable (${
        err instanceof Error ? err.message : String(err)
      }). NOTE: this box has been intermittent; check it before blaming src/reviewer/`
    );
  }
}

// ---------------------------------------------------------------------------
// The GitHub sink.
// ---------------------------------------------------------------------------

interface Posted {
  path: string;
  line?: number;
  side?: string;
  commit_id?: string;
  body?: string;
}

let headSha = "";

async function startSink(): Promise<{
  url: string;
  close: () => void;
  comments: Posted[];
  reviews: Posted[];
}> {
  const comments: Posted[] = [];
  const reviews: Posted[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (url.startsWith(`/repos/${OWNER}/${REPO}/pulls/${String(PR_NUMBER)}/comments`)) {
        comments.push(body as unknown as Posted);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: `http://sink/${url}`, id: comments.length }));
        return;
      }
      if (url.startsWith(`/repos/${OWNER}/${REPO}/pulls/${String(PR_NUMBER)}/reviews`)) {
        reviews.push(body as unknown as Posted);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: `http://sink/${url}`, id: reviews.length }));
        return;
      }
      if (url === `/repos/${OWNER}/${REPO}/pulls/${String(PR_NUMBER)}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            number: PR_NUMBER,
            state: "open",
            draft: false,
            head: { sha: headSha, ref: `factory/${CARD_ID}` },
            html_url: `http://sink/pull/${String(PR_NUMBER)}`,
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found", sink: url }));
    });
  });

  // `listen()` is asynchronous: `server.address()` is still null straight after
  // it is called, which reads as a crash rather than a skip and a confusing one.
  server.listen(0, "127.0.0.1");
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the review sink did not get a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => server.close(),
    comments,
    reviews,
  };
}

// ---------------------------------------------------------------------------
// Run it.
// ---------------------------------------------------------------------------

await preflight();

// A review container that outlives pi's own 5-minute provider timeout needs a
// matching settings.json, exactly as graph-smoke arranges.
const agentTimeout = Number(process.env.REVIEW_TIMEOUT_MS || process.env.AGENT_TIMEOUT_MS || "1200000");
let settingsDir: string | undefined;
if (!process.env.FACTORY_AGENT_SETTINGS_FILE && agentTimeout > 300_000) {
  settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-review-settings-"));
  const file = path.join(settingsDir, "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ httpIdleTimeoutMs: agentTimeout + 60_000 }, null, 2)
  );
  process.env.FACTORY_AGENT_SETTINGS_FILE = file;
  console.log(`[review-smoke] wrote ${file} so pi will not cut a slow model off early`);
}

const fixture: GitRepoFixture = makeGitRepo();
execGit(fixture.repoPath, "config", "user.email", "smoke@factory.local");
execGit(fixture.repoPath, "config", "user.name", "factory-smoke");
process.env.REPO_PATH = fixture.repoPath;
const store = createStore(path.join(fixture.root, "smoke.db"));
const sink = await startSink();
process.env.GITHUB_API_BASE_URL = sink.url;
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "smoke-token-not-a-secret";
process.env.GITHUB_OWNER = OWNER;
process.env.GITHUB_REPO = REPO;

// A deliberately iffy change: an unvalidated argument, a swallowed failure, and a
// comparison that is wrong at the boundary. Not a planted keyword — the reviewer
// has to find the shape of the problem, and a reviewer that posts nothing on *this*
// is a reviewer that is not reading.
execGit(fixture.repoPath, "checkout", "-B", `factory/${CARD_ID}`);
fs.writeFileSync(
  path.join(fixture.repoPath, "src/lookup.js"),
  `export function findUser(db, id) {
  try {
    const rows = db.query("select * from users where id = " + id);
    return rows[0];
  } catch (e) {
    return null;
  }
}

export function firstAdmin(users) {
  for (let i = 0; i <= users.length; i++) {
    if (users[i].role === "admin") return users[i];
  }
  return null;
}
`
);
execGit(fixture.repoPath, "add", "-A");
execGit(fixture.repoPath, "-c", "user.email=s@Smoke.Local", "-c", "user.name=smoke", "commit", "-m", "factory: user lookup");
execGit(fixture.repoPath, "push", "-u", "origin", `factory/${CARD_ID}`);
headSha = execGit(fixture.repoPath, "rev-parse", "HEAD");

console.log(`[review-smoke] card ${CARD_ID}, PR #${String(PR_NUMBER)}, head ${headSha.slice(0, 7)}`);
console.log(`[review-smoke] posting to the sink at ${sink.url}`);

const started = Date.now();
const outcome = await reviewPr(
  CARD_ID,
  {
    number: PR_NUMBER,
    htmlUrl: `http://sink/pull/${String(PR_NUMBER)}`,
    headRef: `factory/${CARD_ID}`,
    headSha,
  },
  { store }
);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

// ---------------------------------------------------------------------------
// What has to be true.
// ---------------------------------------------------------------------------

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const row = store.reviewFor(PR_NUMBER, headSha);
const leaked = fs
  .readdirSync(path.dirname(fixture.repoPath))
  .filter((entry) => entry.startsWith(`wt-${CARD_ID}-r`));

check("reviewPr did not report a failure", outcome.status !== "failed", JSON.stringify(outcome));
check(
  "the sink received at least one line comment",
  sink.comments.length > 0,
  `${String(sink.comments.length)} received`
);
check(
  "every comment is at the reviewed commit, on side RIGHT",
  sink.comments.every((c) => c.commit_id === headSha && c.side === "RIGHT"),
  sink.comments.map((c) => `${String(c.path)}:${String(c.line)}/${String(c.side)}`).join(", ")
);
check(
  "every comment names a file the PR actually changed",
  sink.comments.every((c) => c.path === "src/lookup.js"),
  sink.comments.map((c) => String(c.path)).join(", ")
);
check(
  "every comment line exists in the new version of its file",
  sink.comments.every((c) => typeof c.line === "number" && c.line >= 1 && c.line <= 14),
  sink.comments.map((c) => String(c.line)).join(", ")
);
check(
  "a review summary reached the sink",
  sink.reviews.length === 1,
  `${String(sink.reviews.length)} review(s)`
);
check("the store row closed as posted", row?.status === "posted", String(row?.status));
check("the store counted the comments it accepted", row?.comments === sink.comments.length);
check(
  "the review recorded what it spent",
  typeof row?.usage_in === "number" && (row?.usage_in ?? 0) > 0,
  `${String(row?.usage_in)} in / ${String(row?.usage_out)} out`
);
check("no review worktree was left behind", leaked.length === 0, leaked.join(", "));
check(
  "git has no review worktree registered",
  !execGit(fixture.repoPath, "worktree", "list").includes(`wt-${CARD_ID}-r`)
);

console.log(`\n[review-smoke] ${failures.length === 0 ? "ok" : "FAILED"} in ${elapsed}s`);
if (failures.length) {
  console.log(`  findings: ${sink.comments.map((c) => `${String(c.path)}:${String(c.line)}`).join(", ") || "none"}`);
  console.log(`  summary : ${(sink.reviews[0]?.body ?? "").slice(0, 400)}`);
  console.log(`  failed checks: ${failures.join("; ")}`);
} else {
  for (const c of sink.comments) {
    console.log(`  finding ${String(c.path)}:${String(c.line)}: ${(c.body ?? "").split("\n")[0].slice(0, 120)}`);
  }
}

store.close();
sink.close();
fixture.cleanup();
if (settingsDir) fs.rmSync(settingsDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
