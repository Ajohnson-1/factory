/**
 * Register the board webhook the factory's trigger depends on (phase 2.4).
 *
 *   TRELLO_WEBHOOK_URL=https://<your-vps>/webhook/trello \
 *     npm run register:trello-webhooks
 *
 *   Optional flags: `--dry-run` (print, change nothing), `--skip-preflight`
 *  (register without checking that the callback URL answers HEAD), and a board
 *  id as the first argument to override `TRELLO_BOARD_ID`.
 *
 * Why a script and not the service: a process that creates remote state on boot
 * turns every redeploy into a side effect against somebody's board. This runs
 * when you say so, and prints what it did.
 *
 * Why it reconciles instead of remembering: webhooks belong to the token that
 * created them, and Trello lists them, so the live list is the durable record. A
 * local file of webhook ids would drift the first time a token was rotated —
 * and a rotated or revoked token deletes the registrations silently, per the
 * webhook docs. So: keep at most one webhook per board for this callback URL,
 * delete any other registration this token made against the same board, and
 * create the missing one.
 *
 * The board is the right model to watch, not the card: the docs' action table
 * says `updateCard` fires for a webhook on the Card, the List, the Board and the
 * Member, so one registration per board covers every card that lands in Ready.
 * `README.md` used to instruct the operator to add a webhook from the card menu;
 * there is no such menu — "webhooks are only accessible through the API
 * currently".
 */
import { config } from "../src/config.js";
import { trello, type TrelloWebhook } from "../src/trello/client.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_PREFLIGHT = args.includes("--skip-preflight");
const boardArg = args.find((a) => !a.startsWith("--"));

function die(msg: string): never {
  console.error(`[register-trello-webhooks] ${msg}`);
  process.exit(1);
}

// `boardId()` is a `req()`, and an operator running this on a fresh VPS should
// get a sentence, not a stack trace out of src/config.ts.
let boardId: string;
try {
  boardId = boardArg ?? config.trello.boardId();
} catch (err) {
  die(
    `${err instanceof Error ? err.message : String(err)}\n` +
      "  Set TRELLO_BOARD_ID to the board whose Ready list starts work, or pass\n" +
      "  its id as the first argument to this script."
  );
}
const callbackURL = config.trello.webhookUrl();
const appSecret = config.trello.appSecret();

if (!callbackURL) {
  die(
    "TRELLO_WEBHOOK_URL is not set. It must be the exact public URL of this\n" +
      "  factory's /webhook/trello route — the same string the verifier later\n" +
      "  hashes into X-Trello-Webhook. A trailing slash here that the verifier\n" +
      "  does not use is a signature mismatch on every delivery."
  );
}
if (!appSecret) {
  console.warn(
    "[register-trello-webhooks] TRELLO_APP_SECRET is unset. The webhook will be\n" +
      "  created, but the factory verifies X-Trello-Webhook and refuses every\n" +
      "  delivery while it has no secret to verify with — so nothing will enqueue.\n" +
      "  Find it at https://trello.com/apps/admin."
  );
}

/**
 * Trello HEADs the callback URL and creates nothing unless the answer is 200.
 * Asking first turns that into a readable local error instead of a `POST
 * /1/webhooks` failure that does not say why.
 */
async function preflight(): Promise<void> {
  try {
    const res = await fetch(callbackURL, { method: "HEAD" });
    if (res.status !== 200) {
      die(`HEAD ${callbackURL} answered ${String(res.status)}, not 200.\n` +
        "  Trello will refuse to create the webhook against that answer. Start the\n" +
        "  factory (and check Caddy is routing this host) before registering.");
    }
    console.log(`[register-trello-webhooks] HEAD ${callbackURL} -> 200`);
  } catch (err) {
    die(`HEAD ${callbackURL} failed: ${String(err)}\n` +
      "  The URL has to be reachable from the public internet before Trello will\n" +
      "  register it. Use --skip-preflight to register anyway.");
  }
}

/** The registrations this token already has for this board. */
function forBoard(all: TrelloWebhook[]): TrelloWebhook[] {
  return all.filter((w) => w.idModel === boardId);
}

async function main(): Promise<void> {
  if (!SKIP_PREFLIGHT) await preflight();

  const all = await trello.listWebhooks();
  const ours = forBoard(all);
  const current = ours.filter((w) => w.callbackURL === callbackURL);
  const stale = ours.filter((w) => w.callbackURL !== callbackURL);

  console.log(
    `[register-trello-webhooks] board ${boardId}: ${String(ours.length)} existing ` +
      `registration(s) on this token, ${String(current.length)} for this callback URL, ` +
      `${String(stale.length)} pointing elsewhere`
  );

  if (DRY_RUN) {
    for (const w of all) {
      console.log(
        `  would keep? ${w.callbackURL === callbackURL && w.idModel === boardId ? "yes" : "no"}  ` +
          `id=${w.id} idModel=${w.idModel} callbackURL=${w.callbackURL} active=${String(w.active)}` +
          ` consecutiveFailures=${String(w.consecutiveFailures)}`
      );
    }
    console.log("[register-trello-webhooks] --dry-run: nothing changed");
    return;
  }

  // Newest first: keep one, drop the rest, so running this twice is a no-op and
  // a changed callback URL does not leave two deliveries per card move.
  const keep = current[current.length - 1];
  for (const w of [...current.filter((x) => x.id !== keep?.id), ...stale]) {
    await trello.deleteWebhook(w.id);
    console.log(
      `[register-trello-webhooks] deleted ${w.id} (callbackURL=${w.callbackURL})`
    );
  }

  if (keep) {
    console.log(
      `[register-trello-webhooks] kept ${keep.id} — board webhook already exists` +
        (keep.active === false
          ? "\n  WARNING: it is marked inactive. Trello disables a webhook after\n" +
            "  30 days *and* 1000+ consecutive failures; delete and re-register it."
          : "")
    );
    return;
  }

  const created = await trello.createWebhook(boardId, callbackURL);
  console.log(
    `[register-trello-webhooks] created webhook ${created.id} for board ${boardId}`
  );
}

main().catch((err) => {
  die(String(err));
});
