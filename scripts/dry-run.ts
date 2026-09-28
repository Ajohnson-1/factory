/**
 * Dry-run: exercises the full factory loop against a throwaway local repo.
 * No Trello/Discord/GitHub needed — a mock card is used.
 *
 * This is the opt-in integration smoke test (`npm run test:integration`);
 * it calls a real model, so it is not part of `npm test` or CI.
 *
 * Runtime covered: the in-process one (src/agent/in-process.ts), because that is
 * what a laptop has without a built image. Production runs the container
 * runtime; that path is covered by test/integration/container.test.ts
 * (`TEST_DOCKER=1`) rather than here.
 *
 * Usage: REPO_PATH=<tmp-repo> npx tsx scripts/dry-run.ts
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { commitWork } from "../src/worker/worktree.js";

const CARD_ID = "dryrun-001";
const CARD_NAME = "Add a greet function";
const CARD_DESC =
  "Add a function greet(name: string): string to src/index.js that returns " +
  `"Hello, <name>!". Also add a console.log demo call at the bottom."`;

async function main(): Promise<void> {
  // 1. Throwaway target repo
  const repoPath = process.env.REPO_PATH ?? path.join(os.tmpdir(), "factory-dryrun-repo");
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "src", "index.js"),
    "// entry point\n"
  );
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({ name: "dryrun", version: "1.0.0" })
  );
  execSync(
    `git -C ${repoPath} init && ` +
      `git -C ${repoPath} checkout -b main && ` +
      `git -C ${repoPath} -c user.email=f@f -c user.name=factory add -A && ` +
      `git -C ${repoPath} -c user.email=f@f -c user.name=factory commit -m init`
  );
  console.log(`[dryrun] repo at ${repoPath}`);

  // 2. Worktree (same logic as worker/worktree.ts)
  const branch = `factory/${CARD_ID}`;
  const dir = path.join(path.dirname(repoPath), `wt-${CARD_ID}`);
  fs.rmSync(dir, { recursive: true, force: true });
  execSync(`git -C ${repoPath} worktree add -b ${branch} ${dir} main`);
  console.log(`[dryrun] worktree at ${dir}`);

  // 3. Pi agent run
  const modelRuntime = await ModelRuntime.create();
  const prompt = [
    "You are a factory coding agent. Complete this task.",
    `Task: ${CARD_NAME}`,
    `Details: ${CARD_DESC}`,
    "Rules:",
    "- Work only in the current directory.",
    "- Make the smallest correct change.",
    // same contract as buildAgentPrompt(): .git is read-only for the agent and
    // the host is what turns the working tree into a commit
    "- Do not commit or push — git metadata is mounted read-only where you run.",
    "  Leave the change in the working tree; the factory commits it.",
  ].join("\n");

  const { session } = await createAgentSession({
    cwd: dir,
    modelRuntime,
    sessionManager: SessionManager.inMemory(dir),
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[agent] tool: ${event.toolName}`);
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("[dryrun] agent starting...");
  await session.prompt(prompt);
  session.dispose();

  // 4. The host commits what the agent left behind, exactly like runCard does
  const committed = commitWork(dir, `factory: ${CARD_NAME}`);
  console.log(`[dryrun] host commit: ${committed ? "created" : "nothing to commit"}`);

  // 5. Verify
  const log = execSync(`git -C ${dir} log --oneline -3`).toString();
  const file = fs.readFileSync(path.join(dir, "src", "index.js"), "utf8");
  console.log("\n[dryrun] git log:\n" + log);
  console.log("[dryrun] src/index.js:\n" + file);
  const ok = file.includes("greet") && committed && log.includes("factory:");
  console.log(ok ? "[dryrun] ✅ SUCCESS" : "[dryrun] ❌ agent did not complete task");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[dryrun] fatal:", e);
  process.exit(1);
});
