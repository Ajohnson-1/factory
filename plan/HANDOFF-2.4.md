# Handoff — Phase 2.4 (the Trello trigger), and what 2.5 inherits from it

Work from the repo root. Read `plan/2.4-trello-trigger.md` first — it is the spec,
and it now carries the decision record, the corrections, and the capture
procedure. This file is the state of the ground underneath 2.5: what is proven,
what is only documented, and what nobody has seen yet.

## Repo state (verified, not assumed)

- HEAD `04d5110` — `fix: make the Trello trigger actually fire`. Plan docs land
  on top of it in the same sitting.
- `npm test` → **666 passed, 3 skipped** (docker-gated). `npm run typecheck`
  (both configs) and `npm run build` clean. Coverage 95.41% lines overall;
  `src/trello` **100% lines / 94.23% branch**, above its 80% gate.
- **2.4's definition of done is NOT met.** Not one real Trello delivery has been
  observed. The trigger is implemented, unit-proven and dark. See "The open gate".
- There is no `.env` in this checkout. Everything live happens on the VPS.
- The three ways in are unchanged in number: `store.enqueue` is still the only
  writer of `jobs` — the webhook, Discord `/factory retry`, and
  `scripts/graph-smoke.ts`.

## What 2.4 built (the seams 2.5 must use)

| Seam | Where | Note for 2.5 |
|---|---|---|
| `handleTrelloWebhook(body, deps)` | `src/trello/webhook.ts` | `deps.readyListId` already exists and defaults to config. **That is the multi-tenant seam** — pass each board's own Ready list id and the handler is board-agnostic. It takes the parsed body, never `(req, res)`, so the testable seam survives. |
| `WebhookServerDeps.trello` | `src/server.ts` | The reason the suite is hermetic: the handler performs a lookup, so an injected client is what keeps a trigger test off somebody's live board. Any new inbound handler follows this shape — look at `handleGitHubWebhook`, it is the sibling. |
| `decideTrelloDelivery()` | `src/trello/webhook.ts` | Private, and deliberately so: every HTTP status is one explicit return. A new verdict class means a new branch here, not a new throw somewhere else. |
| `verifyTrelloSignature({rawBody, parsed, header, callbackURL, appSecret})` | same | Pure and synchronous. Note `callbackURL` is an **input**, so N callback URLs means N verification calls — see the trap below. |
| `trello.listWebhooks / createWebhook / deleteWebhook` | `src/trello/client.ts` | `createWebhook` now takes `idModel` (was `cardId`) and returns the created `TrelloWebhook`. |
| `scripts/register-trello-webhooks.ts` | `npm run register:trello-webhooks` | Accepts a board id as an argument, so N boards is a loop, not a rewrite. Reconciles against Trello's live list rather than a local id file. |
| `config.trello.{appSecret,webhookUrl,webhookDebugFile}` | `src/config.ts` | All three are global today. 2.5 has to decide which of them become per-registry-entry. |
| `readBody()` | `src/trello/webhook.ts` | Buffer-concatenated now, so the bytes a signature was computed over survive a chunk boundary. Anything that hashes a body should use it. |

## The trap 2.5 inherits from this design (verified)

`src/server.ts` matches `req.url === "/webhook/trello"` as an **exact string**, so
a query string 404s. Atlassian's own docs recommend telling multiple webhooks
apart by putting your own parameters in the callback URL
(`https://mycallback.com/trelloCallbacks/?memberID=14&mainModel=true`) — and the
callback URL is *part of the signed content*, so per-board URLs are the natural
multi-tenant answer **and** they do not route today. Two ways out; choose on
purpose rather than by accident:

1. **Demux on `webhook.idModel`.** Every delivery names the object it was
   registered on — the docs' example shows `webhook: {id, idModel, callbackURL}`.
   One callback URL, one secret, one webhook per board, and the handler looks up
   which tenant the board belongs to. Costs nothing: `TRELLO_APP_SECRET` is per
   app, not per board. Caveat honest: `idModel` is documented, not yet observed.
2. **Per-board callback URLs.** Requires the router to parse a query string and
   the verifier to be called with the matching URL — and a mismatch is a silent
   401 on every delivery, which is precisely the class of bug 2.4 was created to
   fix.

`jobs` has no `repo_id` column and `card_id` is its primary key. Trello card ids
are unique across a board and boards do not share ids, so this survives 2.5 —
but a card is only addressable by card id, and `cardFromBranch` is already
repo-blind (2.5's plan lists that as a live cross-repo bug, not a gap).

## Facts about Trello that cost real verification — do not re-derive

1. **`action`, `model` and `webhook` are the only three top-level fields, and the
   first two are objects.** The verb is `action.type`; the card is
   `action.data.card.id`. Every prior version of this repo's inbound parser was
   wrong because it assumed strings.
2. **A card move is an `updateCard`.** There is no `updateCardList` action type.
   The only move example in the docs carries `data.old.idList` — the list the card
   *left* — and no destination field at all. Which is why the handler asks
   `getCard` instead of reading the payload.
3. **`X-Trello-Webhook` = base64 HMAC-SHA1 over `body + callbackURL`**, keyed with
   **the application secret from `trello.com/apps/admin`** (the OAuth 1.0 secret;
   for OAuth 2.0 webhooks, the client secret). The docs' own sample hashes
   `JSON.stringify(request.body)` — the re-serialized body — so raw-vs-reserialized
   is unresolved until a capture says (`signedForm`). Both are accepted; either
   requires the secret to forge.
4. **The secret belongs to an app, not to an API key.** A `trello.com/app-key`
   key+token pair may have no application secret at all. If it does not, this
   route can never verify anything and Option A is the answer. Check before
   scheduling work against it.
5. **Registration HEADs the callback URL and requires 200.** An *invalid* SSL
   certificate also blocks creation; a *missing* one does not.
6. **The disable rule needs both thresholds**, not either: 30 days **and** 1000+
   consecutive failures, and one success resets both. Three retries at 30/60/120s.
   A `410 Gone` deletes the webhook outright. A revoked or expired token deletes
   it. Webhooks are "only accessible through the API currently" — there is no UI,
   and the old README's card-menu instruction described a menu that does not exist.
7. **Rate limits: 300 requests per 10 s per API key, 100 per 10 s per token**,
   `/1/members` 100 per 900 s. Not per minute. 429 carries
   `API_KEY_LIMIT_EXCEEDED` / `API_TOKEN_LIMIT_EXCEEDED`, and every response
   carries `x-rate-limit-api-{key,token}-{interval-ms,max,remaining}` — read those
   headers instead of guessing a cadence.
8. **There is no top-level `GET /1/webhooks`.** Listing is
   `GET /1/tokens/{token}/webhooks`. Confirmed against the live API: it answers
   `401 invalid key` while `/1/webhooks` answers `404 Cannot GET`.
9. **The spec declares every write operation's parameters `in: query` and defines
   no `requestBody`** — `POST /webhooks`, `POST /cards/{id}/actions/comments`,
   `PUT /cards/{id}`. This client has always sent JSON. `createWebhook` sends both
   forms now. **`moveCard` and `addComment` still send JSON only, and neither has
   ever been exercised against a real board.** If Trello ignores that body, cards
   stall on the way to Review and the card comment never appears.
10. **`updateCard` fires for a webhook on Card, List, Board and Member** — one
    board-level registration is correct and per-card ones were never needed.
11. **Webhook traffic comes from `104.192.142.240/28`** (and
    `ip-ranges.atlassian.com`, `product: trello`). If the app-secret route in 4
    turns out to be unavailable, that is the fallback authenticator — weaker.
12. **`X-Trello-Client-Identifier` exists** and is echoed back to webhooks owned by
    the key that sent it, "to ensure they are not running a loop". We move cards
    ourselves (`moveCard` → Review/Done), which generates `updateCard` deliveries
    that come back to us. Today the loop is broken by the destination check — a
    card we moved to Review fails the `idList === READY` test and is ignored. It
    is not broken by anything that looks like a loop guard, so if 2.5 adds
    automation that moves cards *into* Ready, put this header to use.

## The open gate — four things, and the first one is a question about existence

1. **Do you have an application secret?** Open `trello.com/apps/admin`, Trello
   Auth tab. If there is no app and only an API key, Option B cannot authenticate
   and the honest move is plan steps 1–5 (the poll), not more webhook code.
2. **Credentials + a reachable host.** `TRELLO_API_KEY`, `TRELLO_TOKEN`,
   `TRELLO_APP_SECRET`, `TRELLO_BOARD_ID`, `READY_LIST_ID`, `TRELLO_WEBHOOK_URL`,
   the factory running, Caddy terminating TLS. Registration cannot be tested
   without it (fact 5).
3. **One capture.** Set `TRELLO_WEBHOOK_DEBUG_FILE`, restart, register, drag a
   card into Ready, paste the line into `plan/2.4-trello-trigger.md` under
   "Captured payload", and answer its four questions. Then delete whichever
   signature candidate lost.
4. **Leave-one-live-call permission**, to settle fact 9 on a scratch card. It
   affects code that predates this phase.

Until 3 is done, "the trigger works" is a documentation claim, not an
observation — the exact sentence this phase exists to stop writing.

## What Option B traded away (so nobody rediscovers it in six weeks)

- Pickup latency: sub-second instead of up to one tick. Nobody will notice,
  because the card then spends minutes in a container either way.
- An operational dependency on a remote lifecycle we do not control: facts 6 and
  the dead-port-for-a-weekend case. `GET /1/tokens/{token}/webhooks` reports
  `active` and `consecutiveFailures`, so a boot check or a `/factory status` line
  that surfaces them is cheap and **has not been built**. Without it, a disabled
  webhook is invisible — the same silence as this bug, arriving by different means.
- Option A is not deleted; it is unbuilt and still correct as written, with
  `GET /1/lists/{id}/cards` now confirmed to exist (and its real parameters
  documented in the plan: `filter` default `visible`, `fields` default `all`,
  `limit` 1–1000, no `page`).

## Working rules that applied this phase

- The plan's own standard, applied to the plan: verify, or label it. Three of its
  claims were wrong or imprecise (the rate-limit window; the top-level webhooks
  list; the assumption that `listAfter` is the destination field). The one about
  `callbackURL` being in the signature was right.
- **Check a subagent's tool list before believing its research.** The one
  dispatched for this returned a confident report with invented domains
  (`developer.atrewson.com`) and wrong numbers, because it had no web access. It
  read as authoritative. Redone in the parent, against the spec file itself.
- A credential that gates paid work fails closed. "Unset means open" is not a
  configuration state.
- Fake payloads name their source in a comment, and a fake that models a request
  the provider cannot send gets deleted, not kept for coverage.
