import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type JobStatus = "queued" | "running" | "review" | "done" | "failed";

export type AgentRunStatus = "running" | "ok" | "failed" | "timeout";

export interface AgentRun {
  run_id: string;
  card_id: string;
  role: string;
  status: AgentRunStatus;
  branch: string | null;
  worktree: string | null;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface Job {
  card_id: string;
  card_name: string;
  status: JobStatus;
  branch: string | null;
  pr_url: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  card_id TEXT PRIMARY KEY,
  card_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  branch TEXT,
  pr_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id     TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  status     TEXT NOT NULL,
  branch     TEXT,
  worktree   TEXT,
  summary    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE INDEX IF NOT EXISTS agent_runs_card_id ON agent_runs(card_id);
`;

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

  return {
    enqueue(cardId: string, cardName: string): void {
      db.prepare(
        `INSERT OR IGNORE INTO jobs (card_id, card_name) VALUES (?, ?)`
      ).run(cardId, cardName);
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
     * Record a new agent run as mid-flight. Throws on a duplicate `runId`:
     * the run id is the primary key and a repeat is a caller bug, not an
     * update to fold in.
     */
    addRun(run: {
      runId: string;
      cardId: string;
      role: string;
      branch?: string;
      worktree?: string;
    }): void {
      db.prepare(
        `INSERT INTO agent_runs
           (run_id, card_id, role, status, branch, worktree, summary, started_at, ended_at)
         VALUES (?, ?, ?, 'running', ?, ?, NULL, ?, NULL)`
      ).run(
        run.runId,
        run.cardId,
        run.role,
        run.branch ?? null,
        run.worktree ?? null,
        Date.now()
      );
    },
    /**
     * Close out a run: status, optional summary, and `ended_at`. An existing
     * summary is kept when `summary` is omitted. An unknown `runId` updates
     * nothing (and creates nothing) — use `activeRuns` to see what is
     * still mid-flight.
     */
    setRunDone(
      runId: string,
      status: AgentRunStatus,
      summary?: string
    ): void {
      if (summary === undefined) {
        db.prepare(
          `UPDATE agent_runs SET status=?, ended_at=? WHERE run_id=?`
        ).run(status, Date.now(), runId);
        return;
      }
      db.prepare(
        `UPDATE agent_runs SET status=?, summary=?, ended_at=? WHERE run_id=?`
      ).run(status, summary, Date.now(), runId);
    },
    runsFor(cardId: string): AgentRun[] {
      return db
        .prepare(
          `SELECT * FROM agent_runs WHERE card_id=? ORDER BY started_at ASC, run_id ASC`
        )
        .all(cardId) as AgentRun[];
    },
    /** Total runs recorded for a card — the `MAX_AGENT_RUNS` budget check. */
    countRuns(cardId: string): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE card_id=?`)
        .get(cardId) as { n: number };
      return row.n;
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
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export const store: Store = createStore(defaultDbPath());
