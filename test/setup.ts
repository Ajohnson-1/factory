/**
 * Global test setup. Runs in every worker process before any module under test
 * is imported, so the guards below cannot be raced by a static import.
 */
import os from "node:os";
import path from "node:path";

// If a module under test transitively imports the default `store`, it must open a
// throwaway DB in the OS temp dir — never the real ./data/factory.db.
// Per-worker (pid) so parallel forks never share a SQLite file.
process.env.FACTORY_DB_PATH ??= path.join(
  os.tmpdir(),
  `factory-vitest-${process.pid}.db`
);
