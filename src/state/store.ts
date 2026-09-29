import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type JobStatus = "queued" | "running" | "review" | "done" | "failed";

export type AgentRunStatus = "running" | "ok" | "failed" | "timeout";

/** Token counts pi reports on `message_end.usage`, summed over one run. */
export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface AgentRun {
  run_id: string;
  card_id: string;
  /**
   * Which attempt of the card this run belongs to (`jobs.generation` at the time
   * it was started). The `MAX_AGENT_RUNS` budget is counted per attempt, so a
   * card that exhausted its budget once can still be re-triggered.
   */
  attempt: number;
  role: string;
  status: AgentRunStatus;
  branch: string | null;
  worktree: string | null;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
  /** Null until the run closes, and stays null for a runtime that reports none. */
  usage_in: number | null;
  usage_out: number | null;
  usage_cache_read: number | null;
}

export interface Job {
  card_id: string;
  card_name: string;
  status: JobStatus;
  branch: string | null;
  pr_url: string | null;
  error: string | null;
}

/**
 * One review of one PR head.
 *
 * `running` is written before the container starts, not after it posts, because
 * 2.3's reviewer posts as it works: a duplicate that arrives mid-run has already
 * put comments on the PR by the time a `posted` row would have existed.
 */
export type ReviewStatus = "running" | "posted" | "skipped" | "failed";

export interface Review {
  pr_number: number;
  card_id: string;
  head_sha: string;
  status: ReviewStatus;
  /** Line comments this review has posted. */
  comments: number;
  /** 0/1 — the summary may only be posted once, and this is what makes it atomic. */
  summary_posted: number;
  error: string | null;
  usage_in: number | null;
  usage_out: number | null;
  usage_cache_read: number | null;
  started_at: number;
  posted_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  card_id TEXT PRIMARY KEY,
  card_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  generation INTEGER NOT NULL DEFAULT 1,
  branch TEXT,
  pr_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id     TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  attempt    INTEGER NOT NULL DEFAULT 1,
  role       TEXT NOT NULL,
  status     TEXT NOT NULL,
  branch     TEXT,
  worktree   TEXT,
  summary    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  usage_in   INTEGER,
  usage_out  INTEGER,
  usage_cache_read INTEGER,
  -- Keyed on (card_id, run_id), not run_id alone: a spawner numbers its children
  -- c1, c2, … from its own counter, so a run id is unique inside one card only.
  PRIMARY KEY (card_id, run_id)
);

CREATE INDEX IF NOT EXISTS agent_runs_card_id ON agent_runs(card_id);

CREATE TABLE IF NOT EXISTS reviews (
  pr_number INTEGER NOT NULL,
  card_id   TEXT NOT NULL,
  head_sha  TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'running',
  comments  INTEGER NOT NULL DEFAULT 0,
  summary_posted INTEGER NOT NULL DEFAULT 0,
  error     TEXT,
  usage_in  INTEGER,
  usage_out INTEGER,
  usage_cache_read INTEGER,
  started_at INTEGER NOT NULL,
  posted_at  INTEGER,
  -- (pr_number, head_sha) is the de-duplication key, and it has to be a primary
  -- key rather than a checked-then-inserted convention: "has this exact head
  -- been reviewed" is the only guard against a redelivered opened-webhook, and
  -- two deliveries that both read "no" before either writes would both run.
  PRIMARY KEY (pr_number, head_sha)
);
`;

/**
 * Both indexes, after the columns exist: `agent_runs_card_attempt` names
 * `attempt`, which on a pre-#1 database only arrives via `ALTER TABLE` — and
 * after a key rebuild, which drops the table's originals with it.
 */
const RUN_INDEXES = `
CREATE INDEX IF NOT EXISTS agent_runs_card_id ON agent_runs(card_id);
CREATE INDEX IF NOT EXISTS agent_runs_card_attempt ON agent_runs(card_id, attempt);
`;

/**
 * Review lookups that are not the primary key: the budget counts a card's
 * reviews, and a redelivered webhook knows only a head SHA, not which PR it was
 * opened against.
 */
const REVIEW_INDEXES = `
CREATE INDEX IF NOT EXISTS reviews_card_id ON reviews(card_id);
CREATE INDEX IF NOT EXISTS reviews_head_sha ON reviews(head_sha);
`;

/**
 * Columns that `SCHEMA` only ever applies to a *new* database.
 *
 * Every statement above is `CREATE TABLE IF NOT EXISTS`, which against a live
 * `/var/lib/factory/factory.db` is a no-op: the table exists, so the new column
 * in the text is simply never applied. Without this list the first run after a
 * deploy writes to a column that is not there.
 */
const ADD_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "jobs", column: "generation", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "agent_runs", column: "attempt", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "agent_runs", column: "usage_in", ddl: "INTEGER" },
  { table: "agent_runs", column: "usage_out", ddl: "INTEGER" },
  { table: "agent_runs", column: "usage_cache_read", ddl: "INTEGER" },
];

/**
 * The shape `SCHEMA` gives a new table, used again by the rebuild below.
 *
 * `run_id` is the whole primary key in the pre-#1 table, while every spawner
 * numbers its children from `c1`: the second card the factory ever processed
 * threw `UNIQUE constraint failed` on its first child, and so would a
 * re-triggered attempt — which is what open-issues #1 exists to enable.
 */
const AGENT_RUNS_COLUMNS = `
  run_id     TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  attempt    INTEGER NOT NULL DEFAULT 1,
  role       TEXT NOT NULL,
  status     TEXT NOT NULL,
  branch     TEXT,
  worktree   TEXT,
  summary    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  usage_in   INTEGER,
  usage_out  INTEGER,
  usage_cache_read INTEGER,
  PRIMARY KEY (card_id, run_id)
`;

/** True only for the pre-#1 table, which was keyed on `run_id` alone. */
function keyedOnRunIdAlone(db: Database.Database): boolean {
  const pk = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
  return pk.length === 1 && pk[0] === "run_id";
}

/**
 * Re-key an existing `agent_runs` on `(card_id, run_id)`.
 *
 * SQLite cannot alter a primary key, so this is the copy-and-swap: build the
 * table with the right key, move every row across, drop the old one. A rebuild
 * rather than a name change, because the collision is in the constraint and a
 * second card has to be able to record `c1` too.
 */
function rebuildRunKey(db: Database.Database): void {
  const columnList = `run_id, card_id, attempt, role, status, branch, worktree, summary,
                      started_at, ended_at, usage_in, usage_out, usage_cache_read`;
  db.transaction(() => {
    db.exec(`CREATE TABLE agent_runs_new (${AGENT_RUNS_COLUMNS});`);
    db.exec(
      `INSERT INTO agent_runs_new (${columnList})
         SELECT ${columnList} FROM agent_runs;`
    );
    db.exec(`DROP TABLE agent_runs;`);
    db.exec(`ALTER TABLE agent_runs_new RENAME TO agent_runs;`);
  })();
}

/**
 * Add every missing column, returning what was added.
 *
 * `ALTER TABLE … ADD COLUMN` with a `NOT NULL DEFAULT` backfills existing rows,
 * which is what makes an old run read back as `attempt = 1` — the first attempt
 * of that card, and the only interpretation that is not a lie.
 */
function applyAddColumns(db: Database.Database): string[] {
  const added: string[] = [];
  for (const { table, column, ddl } of ADD_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

/** Where the default store lives: `FACTORY_DB_PATH`, else `./data/factory.db`. */
export function defaultDbPath(): string {
  return (
    process.env.FACTORY_DB_PATH ??
    path.resolve(process.cwd(), "data", "factory.db")
  );
}

/**
 * A job store bound to one SQLite file. Tests build their own against a temp
 * path; production uses the default `store` below.
 */
export function createStore(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  // Order matters: the copy below reads `attempt`, which only exists after the
  // columns have been added to a pre-#1 table.
  applyAddColumns(db);
  if (keyedOnRunIdAlone(db)) rebuildRunKey(db);
  db.exec(RUN_INDEXES);
  db.exec(REVIEW_INDEXES);

  return {
    /**
     * Put a card in the queue — the one re-trigger path, used by the Trello
     * webhook and by `/factory retry` alike.
     *
     * A card seen for the first time is queued at generation 1. A card that has
     * *finished* (failed, review, done) is queued again and its generation goes
     * up, so the next attempt gets a fresh run budget instead of inheriting the
     * one it already spent. A card that is `running` or already `queued` is left
     * exactly as it is: re-dragging it must not start a second graph over the
     * first one.
     */
    enqueue(
      cardId: string,
      cardName: string
    ): { queued: boolean; requeued: boolean; generation: number } {
      const existing = db
        .prepare(`SELECT status, generation FROM jobs WHERE card_id=?`)
        .get(cardId) as { status: JobStatus; generation: number } | undefined;

      if (!existing) {
        db.prepare(`INSERT INTO jobs (card_id, card_name) VALUES (?, ?)`).run(
          cardId,
          cardName
        );
        return { queued: true, requeued: false, generation: 1 };
      }
      if (existing.status === "running" || existing.status === "queued") {
        return { queued: false, requeued: false, generation: existing.generation };
      }
      db.prepare(
        `UPDATE jobs SET status='queued', card_name=?, error=NULL,
                generation=generation+1, updated_at=datetime('now') WHERE card_id=?`
      ).run(cardName, cardId);
      return {
        queued: true,
        requeued: true,
        generation: existing.generation + 1,
      };
    },
    /**
     * The attempt number children of this card are recorded under. 1 for a card
     * with no row yet, so a caller that never went through `enqueue` (a test,
     * `graph-smoke`) still gets a usable budget.
     */
    attemptFor(cardId: string): number {
      const row = db
        .prepare(`SELECT generation FROM jobs WHERE card_id=?`)
        .get(cardId) as { generation: number } | undefined;
      return row?.generation ?? 1;
    },
    setRunning(cardId: string, branch: string): void {
      db.prepare(
        `UPDATE jobs SET status='running', branch=?, updated_at=datetime('now') WHERE card_id=?`
      ).run(branch, cardId);
    },
    setReview(cardId: string, prUrl: string): void {
      db.prepare(
        `UPDATE jobs SET status='review', pr_url=?, updated_at=datetime('now') WHERE card_id=?`
      ).run(prUrl, cardId);
    },
    setDone(cardId: string): void {
      db.prepare(
        `UPDATE jobs SET status='done', updated_at=datetime('now') WHERE card_id=?`
      ).run(cardId);
    },
    setFailed(cardId: string, error: string): void {
      db.prepare(
        `UPDATE jobs SET status='failed', error=?, updated_at=datetime('now') WHERE card_id=?`
      ).run(error, cardId);
    },
    get(cardId: string): Job | undefined {
      return db.prepare(`SELECT * FROM jobs WHERE card_id=?`).get(cardId) as
        | Job
        | undefined;
    },
    all(): Job[] {
      return db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC`).all() as Job[];
    },
    nextQueued(): Job | undefined {
      return db.prepare(
        `SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1`
      ).get() as Job | undefined;
    },
    /**
     * Record a new agent run as mid-flight. Throws when the same card records
     * the same `runId` twice — a run id is a spawner's counter, so a repeat is a
     * caller bug, not an update to fold in. A *different* card may use the same
     * id, and does, constantly: that is why the key is `(card_id, run_id)`.
     */
    addRun(run: {
      runId: string;
      cardId: string;
      role: string;
      /** Attempt this run belongs to; see `attemptFor`. Defaults to 1. */
      attempt?: number;
      branch?: string;
      worktree?: string;
    }): void {
      db.prepare(
        `INSERT INTO agent_runs
           (run_id, card_id, attempt, role, status, branch, worktree, summary,
            started_at, ended_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, ?, NULL)`
      ).run(
        run.runId,
        run.cardId,
        run.attempt ?? 1,
        run.role,
        run.branch ?? null,
        run.worktree ?? null,
        Date.now()
      );
    },
    /**
     * Close out one run of one card: status, optional summary, optional token
     * usage, and `ended_at`. An existing summary is kept when `summary` is
     * omitted. An unknown `runId` updates nothing (and creates nothing) — use
     * `activeRuns` to see what is still mid-flight.
     *
     * `cardId` is part of the address, not decoration: two cards both have a
     * `c1`, and closing one must never close the other.
     */
    setRunDone(
      cardId: string,
      runId: string,
      status: AgentRunStatus,
      summary?: string,
      usage?: RunUsage
    ): void {
      const sets = [`status=?`, `ended_at=?`];
      const values: (string | number | null)[] = [status, Date.now()];
      if (summary !== undefined) {
        sets.push(`summary=?`);
        values.push(summary);
      }
      if (usage) {
        sets.push(`usage_in=?`, `usage_out=?`, `usage_cache_read=?`);
        values.push(usage.input, usage.output, usage.cacheRead);
      }
      values.push(cardId, runId);
      db.prepare(
        `UPDATE agent_runs SET ${sets.join(", ")} WHERE card_id=? AND run_id=?`
      ).run(...values);
    },
    /** Runs for a card — one attempt when `attempt` is given, else all history. */
    runsFor(cardId: string, attempt?: number): AgentRun[] {
      if (attempt === undefined) {
        return db
          .prepare(
            `SELECT * FROM agent_runs WHERE card_id=? ORDER BY started_at ASC, run_id ASC`
          )
          .all(cardId) as AgentRun[];
      }
      return db
        .prepare(
          `SELECT * FROM agent_runs WHERE card_id=? AND attempt=?
             ORDER BY started_at ASC, run_id ASC`
        )
        .all(cardId, attempt) as AgentRun[];
    },
    /**
     * Runs recorded for a card — the `MAX_AGENT_RUNS` budget check.
     *
     * `attempt` scopes it to one run of the card. Omit it and you get every
     * attempt ever, which is what a cost question wants and what a budget
     * question must never use: a card that spent 12 runs failing yesterday is
     * entitled to 12 today.
     */
    countRuns(cardId: string, attempt?: number): number {
      const row = (attempt === undefined
        ? db
            .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE card_id=?`)
            .get(cardId)
        : db
            .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE card_id=? AND attempt=?`)
            .get(cardId, attempt)) as { n: number };
      return row.n;
    },
    /**
     * Token totals per card over all attempts — the money view, not the budget
     * view. `MAX_AGENT_RUNS` only becomes a cost guardrail once there is a cost
     * number next to it.
     *
     * `reported` is how many of those runs actually carried a `usage` event.
     * `COALESCE(SUM(...), 0)` makes "nothing reported" and "cost nothing" the
     * same number, which is a lie we already refused in `setRunDone` (NULL, not
     * 0), so the count travels with the totals and the view can say which one
     * it is looking at. A card that ran on the `process` runtime reports no
     * usage at all and must not read as a free card.
     */
    usageByCard(): {
      card_id: string;
      runs: number;
      reported: number;
      input: number;
      output: number;
      cache_read: number;
    }[] {
      return db
        .prepare(
          `SELECT card_id,
                  COUNT(*) AS runs,
                  COUNT(usage_in) AS reported,
                  COALESCE(SUM(usage_in), 0) AS input,
                  COALESCE(SUM(usage_out), 0) AS output,
                  COALESCE(SUM(usage_cache_read), 0) AS cache_read
             FROM agent_runs GROUP BY card_id ORDER BY card_id`
        )
        .all() as never;
    },
    /**
     * Claim the right to review one head SHA, or refuse it.
     *
     * Both refusals are ordinary traffic rather than faults, so this returns a
     * reason instead of throwing: `duplicate` is a redelivered webhook or a push
     * that raced us, `budget` is `REVIEW_MAX_RUNS_PER_CARD`. The row is written
     * here, before the container starts and before anything is posted, because
     * the reviewer posts findings as it works — a check that ran after the first
     * comment would be a check that arrives after the money is spent.
     *
     * `skipped` and `failed` rows are re-claimable. That SHA was never reviewed
     * successfully, and a review that died part-way may have posted some comments,
     * which is something an operator can read off the row rather than a reason to
     * refuse the head forever.
     */
    startReview(opts: {
      prNumber: number;
      cardId: string;
      headSha: string;
      maxPerCard: number;
    }): { begin: boolean; reason?: "duplicate" | "budget" } {
      return db.transaction(() => {
        const existing = db
          .prepare(`SELECT status FROM reviews WHERE pr_number=? AND head_sha=?`)
          .get(opts.prNumber, opts.headSha) as { status: ReviewStatus } | undefined;
        if (existing && (existing.status === "running" || existing.status === "posted")) {
          return { begin: false, reason: "duplicate" as const };
        }
        // One row per distinct head SHA, and a re-claim does not add one, so the
        // row count is the number of model runs this card has asked for. This is
        // deliberately not `countRuns`: reviews are not graph children, and
        // counting them there would let a PR push eat a coder's budget.
        const used = (
          db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE card_id=?`).get(opts.cardId) as {
            n: number;
          }
        ).n;
        if (used >= opts.maxPerCard) return { begin: false, reason: "budget" as const };

        const now = Date.now();
        if (existing) {
          db.prepare(
            `UPDATE reviews SET card_id=?, status='running', error=NULL, comments=0,
                    summary_posted=0, started_at=?, posted_at=NULL
               WHERE pr_number=? AND head_sha=?`
          ).run(opts.cardId, now, opts.prNumber, opts.headSha);
          return { begin: true };
        }
        db.prepare(
          `INSERT INTO reviews (pr_number, card_id, head_sha, status, started_at)
           VALUES (?, ?, ?, 'running', ?)`
        ).run(opts.prNumber, opts.cardId, opts.headSha, now);
        return { begin: true };
      })();
    },
    reviewFor(prNumber: number, headSha: string): Review | undefined {
      return db
        .prepare(`SELECT * FROM reviews WHERE pr_number=? AND head_sha=?`)
        .get(prNumber, headSha) as Review | undefined;
    },
    /**
     * How many reviews a card has had, across every PR and every head.
     *
     * `startReview` enforces the cap inside its own transaction; this is the number
     * for the log line, where an operator wants to see *what the limit is* rather
     * than only that something refused.
     */
    countReviews(cardId: string): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM reviews WHERE card_id=?`)
        .get(cardId) as { n: number };
      return row.n;
    },
    /**
     * Count a posted line comment against its review.
     *
     * Called *after* the post succeeded. The alternative — reserve a slot, then
     * post — would let a flaky API call spend the cap without anything appearing
     * on the PR, which is the worse way to be wrong about money.
     */
    bumpReviewComment(prNumber: number, headSha: string): number {
      db.prepare(`UPDATE reviews SET comments=comments+1 WHERE pr_number=? AND head_sha=?`).run(
        prNumber,
        headSha
      );
      const row = db
        .prepare(`SELECT comments AS n FROM reviews WHERE pr_number=? AND head_sha=?`)
        .get(prNumber, headSha) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    /**
     * Take the right to post the review summary. Exactly one caller can win, and
     * a second `post_review` with no path gets `false` rather than a second
     * review on the PR.
     */
    claimReviewSummary(prNumber: number, headSha: string): boolean {
      const info = db
        .prepare(
          `UPDATE reviews SET summary_posted=1 WHERE pr_number=? AND head_sha=? AND summary_posted=0`
        )
        .run(prNumber, headSha);
      return info.changes === 1;
    },
    /** Close out a review. `usage` stays NULL for a run that reported none. */
    markReview(
      prNumber: number,
      headSha: string,
      status: ReviewStatus,
      opts: { error?: string; usage?: RunUsage } = {}
    ): void {
      const now = Date.now();
      if (opts.usage) {
        db.prepare(
          `UPDATE reviews SET status=?, error=?, posted_at=?,
                  usage_in=?, usage_out=?, usage_cache_read=?
             WHERE pr_number=? AND head_sha=?`
        ).run(
          status,
          opts.error ?? null,
          now,
          opts.usage.input,
          opts.usage.output,
          opts.usage.cacheRead,
          prNumber,
          headSha
        );
        return;
      }
      db.prepare(`UPDATE reviews SET status=?, error=?, posted_at=? WHERE pr_number=? AND head_sha=?`).run(
        status,
        opts.error ?? null,
        now,
        prNumber,
        headSha
      );
    },
    /** Per-card review spend, so a reviewer's tokens are not invisible. */
    usageByReviewCard(): {
      card_id: string;
      reviews: number;
      reported: number;
      input: number;
      output: number;
      cache_read: number;
    }[] {
      return db
        .prepare(
          `SELECT card_id,
                  COUNT(*) AS reviews,
                  COUNT(usage_in) AS reported,
                  COALESCE(SUM(usage_in), 0) AS input,
                  COALESCE(SUM(usage_out), 0) AS output,
                  COALESCE(SUM(usage_cache_read), 0) AS cache_read
             FROM reviews GROUP BY card_id ORDER BY card_id`
        )
        .all() as never;
    },
    /** Runs still mid-flight: all cards when `cardId` is omitted. */
    activeRuns(cardId?: string): AgentRun[] {
      if (cardId === undefined) {
        return db
          .prepare(
            `SELECT * FROM agent_runs WHERE status='running' ORDER BY started_at ASC, run_id ASC`
          )
          .all() as AgentRun[];
      }
      return db
        .prepare(
          `SELECT * FROM agent_runs WHERE card_id=? AND status='running' ORDER BY started_at ASC, run_id ASC`
        )
        .all(cardId) as AgentRun[];
    },
    isRunning(): boolean {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE status='running'`
      ).get() as { n: number };
      return row.n > 0;
    },
    /**
     * Mark everything this process inherited as mid-flight as failed.
     *
     * A kill mid-card leaves `agent_runs.status='running'` rows that will never
     * be closed: `/factory status` lists children that no longer exist, and they
     * count against the budget forever. Only a boot-time sweep can tell a stale
     * row from a live one, because at boot nothing is live — which is why
     * `startWorker` calls this before its first tick and never on a timer.
     *
     * Idempotent: a second call finds nothing `running` and reaps nothing.
     */
    reapStale(
      runSummary = "reaped: orchestrator restarted mid-run",
      jobError = "reaped: the factory restarted while this card was running",
      reviewError = "reaped: the factory restarted while this review was running"
    ): {
      runs: { run_id: string; card_id: string; role: string }[];
      jobs: { card_id: string; card_name: string }[];
      reviews: { pr_number: number; card_id: string }[];
    } {
      const runs = db
        .prepare(
          `SELECT run_id, card_id, role FROM agent_runs WHERE status='running'
             ORDER BY started_at ASC, run_id ASC`
        )
        .all() as { run_id: string; card_id: string; role: string }[];
      const jobs = db
        .prepare(
          `SELECT card_id, card_name FROM jobs WHERE status='running' ORDER BY created_at, card_id`
        )
        .all() as { card_id: string; card_name: string }[];
      // Reviews are swept too, and this one is load-bearing rather than tidying:
      // a `running` review row is a head SHA that `startReview` will refuse
      // forever, so a process killed mid-review would silently make that push
      // unreviewable, and the operator would have to know to delete a row.
      const reviews = db
        .prepare(
          `SELECT pr_number, card_id FROM reviews WHERE status='running'
             ORDER BY started_at ASC, pr_number ASC`
        )
        .all() as { pr_number: number; card_id: string }[];

      db.transaction(() => {
        if (runs.length) {
          db.prepare(
            `UPDATE agent_runs SET status='failed', summary=?, ended_at=?
               WHERE status='running'`
          ).run(runSummary, Date.now());
        }
        if (jobs.length) {
          db.prepare(
            `UPDATE jobs SET status='failed', error=?, updated_at=datetime('now')
               WHERE status='running'`
          ).run(jobError);
        }
        if (reviews.length) {
          db.prepare(
            `UPDATE reviews SET status='failed', error=?, posted_at=? WHERE status='running'`
          ).run(reviewError, Date.now());
        }
      })();

      return { runs, jobs, reviews };
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export const store: Store = createStore(defaultDbPath());
