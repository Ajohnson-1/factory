/**
 * Test: simulate a GitHub PR-merge webhook → job done + card Done.
 * Usage: npx tsx src/test-merge-webhook.ts
 */
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { store } from "./state/store.js";
import { handleGitHubWebhook, verifySignature } from "./github/webhook.js";

process.env.TRELLO_API_KEY ??= "test";
process.env.TRELLO_TOKEN ??= "test";
process.env.TRELLO_BOARD_ID ??= "test";
process.env.READY_LIST_ID ??= "test";
process.env.REVIEW_LIST_ID ??= "test";
process.env.DONE_LIST_ID ??= "test";
process.env.GITHUB_WEBHOOK_SECRET ??= "testsecret";

const CARD_ID = "test-card-1";

async function main(): Promise<void> {
  store.enqueue(CARD_ID, "Test card");
  store.setReview(CARD_ID, "https://github.com/x/y/pull/1");

  const payload = JSON.stringify({
    action: "closed",
    pull_request: {
      merged: true,
      html_url: "https://github.com/x/y/pull/1",
      head: { ref: `factory/${CARD_ID}` },
    },
  });

  // 1. Signature check
  const sig =
    "sha256=" +
    crypto.createHmac("sha256", "testsecret").update(payload).digest("hex");
  const req = Object.assign(Readable.from([payload]), {
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sig,
    },
  }) as unknown as IncomingMessage;

  if (!verifySignature(req, payload)) throw new Error("signature failed");
  console.log("✅ signature verified");

  // 2. Handle (mock bot; trello calls fail gracefully with dummy creds)
  const sent: string[] = [];
  const bot = {
    send: async (e: any) => {
      sent.push(e.data.title ?? "?");
    },
  } as any;
  const res = new ServerResponse({} as any);
  await handleGitHubWebhook(req, res, bot);

  const job = store.get(CARD_ID);
  console.log("job status:", job?.status);
  console.log("discord embeds:", sent);
  if (job?.status !== "done") throw new Error("job not marked done");
  console.log("✅ merge webhook → card Done works");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
