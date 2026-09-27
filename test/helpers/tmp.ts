import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A private temp dir for one test. Nothing under test may touch ./data or the real repo. */
export function makeTempDir(prefix = "factory-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
