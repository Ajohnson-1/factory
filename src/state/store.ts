import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "factory.db"));

db.exec(`
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
`);

export type JobStatus = "queued" | "running" | "review" | "done" | "failed";

export interface Job {
  card_id: string;
  card_name: string;
  status: JobStatus;
  branch: string | null;
  pr_url: string | null;
  error: string | null;
}

export const store = {
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
    return db.prepare(`SELECT * FROM jobs WHERE card_id=?`).get(cardId) as Job | undefined;
  },
  all(): Job[] {
    return db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC`).all() as Job[];
  },
  nextQueued(): Job | undefined {
    return db.prepare(
      `SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1`
    ).get() as Job | undefined;
  },
  isRunning(): boolean {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE status='running'`
    ).get() as { n: number };
    return row.n > 0;
  },
};
