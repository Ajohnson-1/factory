// Ask-a-human protocol for the software factory (card 6ae736ef0f4a495c1122d2fe).
// Pipeline spec + agent-facing protocol: docs/factory.md ("Asking a human").
//
// A stage agent that hits an ambiguity runs:
//   node scripts/factory.js ask <card> <question|-> [--timeout ms] [--interval ms] [--no-wait]
// which (1) posts `[ASK] <question>` as a card comment, (2) best-effort pings the
// owner on Discord (bot DM via REST v10, or FACTORY_DISCORD_WEBHOOK override;
// ping failure NEVER blocks the wait), and (3) unless --no-wait, polls card
// comments until the earliest human reply dated after the ask comment (an
// `[HUMAN]`-tagged comment, or any comment authored by a member other than the
// bot — identity via `GET /members/me`), returning it. On timeout the CLI
// exits 1 so the scheduler bounces/parks per
// existing rules. `wait` is the resume half (ask once, wait many times across
// restarts) — same poll loop, no post/ping.
//
// Dependency-injectable logic, the deploy.js/deploy-ssh.js pattern: every seam
// (trello client, notify, sleep, fetch, clock) defaults to the real thing and is
// faked in tests/factoryAsk.test.js — zero live Trello/Discord in tests.
//
// Reply detection is DATE-BASED, not incremental: comments that arrived before
// polling started are still found, so a stage that died and restarted can simply
// re-run `wait` to collect the answer.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DISCORD_API = 'https://discord.com/api/v10';

const fileEnv = parseDotEnv();

export function envNum(name, fallback) {
  const n = Number(process.env[name] || fileEnv[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readConfig(configDir) {
  try {
    return JSON.parse(readFileSync(resolve(configDir, 'config', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function normalizeIso(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Split CLI argv into `{ flags, positional }`.
 * Value flags: --timeout <ms>, --interval <ms> (positive numbers → flags.timeoutMs
 * / flags.intervalMs), --since <ISO8601> (normalized → flags.sinceIso).
 * Boolean flags: --no-wait (→ flags.noWait), --once (→ flags.once), --no-ping
 * (→ flags.noPing), --dry-run (→ flags.dryRun). Everything else is positional.
 * Throws on a missing/invalid flag value (factory.js's run().catch(die) surfaces it).
 */
export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  const numeric = { '--timeout': 'timeoutMs', '--interval': 'intervalMs' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (numeric[a]) {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isFinite(n) || n <= 0) {
        throw new Error(`Missing or invalid ${a} value: ${v} (positive milliseconds expected)`);
      }
      flags[numeric[a]] = n;
      continue;
    }
    if (a === '--since') {
      const iso = normalizeIso(argv[++i]);
      if (!iso) throw new Error(`Missing or invalid --since value: ${argv[i]} (ISO 8601 expected)`);
      flags.sinceIso = iso;
      continue;
    }
    if (a === '--no-wait') {
      flags.noWait = true;
      continue;
    }
    if (a === '--once') {
      flags.once = true;
      continue;
    }
    if (a === '--no-ping') {
      flags.noPing = true;
      continue;
    }
    if (a === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * True when `member` (a comment's memberCreator) is the bot account `bot`.
 * Prefer immutable member ids (usernames can be renamed); fall back to a
 * case-insensitive username compare; a member with neither usable id nor
 * username is treated as human (only fake clients produce such objects).
 */
export function isBotMember(member, bot) {
  if (!member || !bot) return false;
  if (member.id != null && bot.id != null) return String(member.id) === String(bot.id);
  if (member.username != null && bot.username != null) {
    return String(member.username).toLowerCase() === String(bot.username).toLowerCase();
  }
  return false;
}

/**
 * Pick the earliest human reply among Trello commentCard actions. `actions`
 * items carry `{ id, date, data.text, memberCreator }` (see trello.js
 * getCardComments). A comment qualifies when its date is strictly after
 * `sinceDate` — or in the same second as the ask but with a different comment
 * id (Trello dates are second-granular) —, its id is not `excludeCommentId`
 * (the ask comment's own id), and EITHER its trimmed text starts with
 * `[HUMAN]` (case-insensitive fast-path, author-agnostic) OR `bot` identity is
 * known, the action carries a `memberCreator`, and that author is NOT the bot
 * (author-based detection). While `bot` is unknown only tagged comments
 * qualify — fail-closed degraded mode. Returns `{ text, date, author, via }`
 * of the EARLIEST match (`via` is `'tag'` or `'author'`), or null.
 */
export function extractHumanReply(actions, { sinceDate, excludeCommentId, bot } = {}) {
  const sinceMs = Date.parse(sinceDate ?? '');
  const hasSince = Number.isFinite(sinceMs);
  const botKnown = Boolean(bot && (bot.id != null || bot.username != null));
  const matches = [];
  for (const a of actions ?? []) {
    const text = String(a?.data?.text ?? a?.text ?? '').trim();
    const tagged = /^\[HUMAN\]/i.test(text);
    const viaAuthor = botKnown && a?.memberCreator != null && !isBotMember(a.memberCreator, bot);
    if (!tagged && !viaAuthor) continue;
    if (a?.id && a.id === excludeCommentId) continue;
    const ms = Date.parse(a?.date ?? '');
    if (hasSince) {
      if (!Number.isFinite(ms)) continue;
      if (ms < sinceMs) continue; // strictly after, or same-second (kept; the ask comment itself is excluded by id above)
    }
    matches.push({
      text,
      date: a.date,
      author: a.memberCreator?.fullName ?? a.memberCreator?.username ?? 'unknown',
      via: tagged ? 'tag' : 'author',
    });
  }
  matches.sort((x, y) => String(x.date).localeCompare(String(y.date)));
  return matches[0] ?? null;
}

/**
 * Best-effort Discord ping to the factory owner. NEVER throws.
 * - `FACTORY_DISCORD_WEBHOOK` (env or .env) overrides everything: one
 *   plain webhook POST `{content}` — the escape hatch when a DM cannot be opened.
 * - `FACTORY_CHANNEL_ID` (env or .env): post {content} straight to that
 *   channel (POST /channels/<id>/messages) with the bot token — the factory
 *   repo's own server/channel (FACTORY_SERVER_ID names the guild the bot was
 *   invited to; it is not needed for the send). Needs a token, no owner id.
 * - Otherwise bot DM: POST /users/@me/channels {recipient_id} then
 *   POST /channels/<dm-id>/messages, Authorization `Bot <token>`.
 *   token  = DISCORD_BOT_TOKEN || BOT_TOKEN (env → .env → config/config.json)
 *   recipient = FACTORY_DISCORD_USER_ID || SUPER_USER_ID (env → .env) ||
 *               config/config.json superUserId
 * config/config.json is read DIRECTLY (try/catch) instead of importing config.js,
 * avoiding that module's multi-bot identity aborts.
 * → `{ sent: true }` | `{ error: string }`
 */
export async function sendOwnerPing({
  text,
  fetchImpl = fetch,
  env = process.env,
  fileEnv = parseDotEnv(),
  configDir = ROOT,
}) {
  try {
    const cfg = readConfig(configDir);
    const webhook = env.FACTORY_DISCORD_WEBHOOK || fileEnv.FACTORY_DISCORD_WEBHOOK;
    if (webhook) {
      const res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) return { error: `Discord webhook -> HTTP ${res.status}` };
      return { sent: true };
    }
    const token =
      env.DISCORD_BOT_TOKEN || fileEnv.DISCORD_BOT_TOKEN || env.BOT_TOKEN || fileEnv.BOT_TOKEN || cfg.BOT_TOKEN;
    const channelId = env.FACTORY_CHANNEL_ID || fileEnv.FACTORY_CHANNEL_ID;
    if (channelId) {
      if (!token) {
        return { error: `missing Discord bot token for FACTORY_CHANNEL_ID (BOT_TOKEN / DISCORD_BOT_TOKEN)` };
      }
      const chRes = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bot ${token}` },
        body: JSON.stringify({ content: text }),
      });
      if (!chRes.ok) return { error: `Discord channel ${channelId} send -> HTTP ${chRes.status}` };
      return { sent: true };
    }
    const userId =
      env.FACTORY_DISCORD_USER_ID ||
      fileEnv.FACTORY_DISCORD_USER_ID ||
      env.SUPER_USER_ID ||
      fileEnv.SUPER_USER_ID ||
      cfg.superUserId;
    if (!token || !userId) {
      return { error: `missing Discord ${!token ? 'bot token' : 'owner id'} (BOT_TOKEN / FACTORY_DISCORD_USER_ID or config.json superUserId)` };
    }
    const headers = { 'content-type': 'application/json', Authorization: `Bot ${token}` };
    const dmRes = await fetchImpl(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dmRes.ok) return { error: `Discord DM open -> HTTP ${dmRes.status}` };
    const dm = await dmRes.json();
    if (!dm?.id) return { error: 'Discord DM open returned no channel id' };
    const sendRes = await fetchImpl(`${DISCORD_API}/channels/${dm.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: text }),
    });
    if (!sendRes.ok) return { error: `Discord DM send -> HTTP ${sendRes.status}` };
    return { sent: true };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

async function pollForReply({ cardId, sinceDate, excludeCommentId, timeoutMs, intervalMs, board, t, sleep, now }) {
  const startMs = Date.parse(now());
  let polls = 0;
  // Bot identity: undefined = unresolved (retry next poll), null/object = settled.
  // One SUCCESSFUL lookup is cached for the whole run; failures cost ≤1 GET per
  // poll and self-heal, so a transient error never locks the wait into legacy
  // mode. A client without getMe (or a permanently failing one) stays tag-only —
  // fail-CLOSED: the bot's own [ASK] echo / stage comments cannot be mistaken
  // for the human's answer.
  let bot;
  for (;;) {
    if (bot === undefined && typeof t.getMe === 'function') {
      try {
        const me = await t.getMe({ board });
        if (me?.id != null || me?.username != null) bot = me;
      } catch {
        /* identity lookup failed — fail-closed (tag-only) until a retry succeeds */
      }
    }
    const actions = await t.getCardComments(cardId, undefined, { board });
    polls += 1;
    const reply = extractHumanReply(actions, { sinceDate, excludeCommentId, bot: bot ?? null });
    if (reply) return { replied: true, reply, polls, waitedMs: Date.parse(now()) - startMs };
    const waitedMs = Date.parse(now()) - startMs;
    if (waitedMs >= timeoutMs) return { replied: false, timedOut: true, polls, waitedMs };
    await sleep(intervalMs);
  }
}

/**
 * Post `[ASK] <question>` on the card, ping the owner on Discord, then (unless
 * noWait) block until a human reply appears (author-based; the `[HUMAN]` tag is
 * an optional fast-path) or timeoutMs elapses.
 * The `[ASK] ` tag is auto-prefixed unless the question already starts with it.
 * Deps injectable for tests: t (trello client: addComment/getCardComments/getCard),
 * notify (defaults to sendOwnerPing; failure is recorded, never thrown),
 * sleep/now (clock seams).
 * → { card, asked:true, askCommentId, discord, replied, reply?, timedOut?,
 *     noWait?, polls, waitedMs }
 */
export async function askHuman({
  cardId,
  question,
  timeoutMs = envNum('FACTORY_ASK_TIMEOUT_MS', 3_600_000),
  intervalMs = envNum('FACTORY_ASK_POLL_MS', 30_000),
  noWait = false,
  board = undefined, // FM-2 per-board pass-through, docs/factory-migration.md §4.3
  t = trello,
  notify = sendOwnerPing,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString(),
}) {
  const q = String(question ?? '').trim();
  const text = /^\[ASK\]/i.test(q) ? q : `[ASK] ${q}`;
  const posted = await t.addComment(cardId, text, { board });
  const askCommentId = posted?.id;
  const sinceDate = normalizeIso(posted?.date) || now();

  // Ping text: card name/url from the board; a lookup failure degrades gracefully
  // (url-only, then a constructed card URL) — the ping must never out-fail the ask.
  let card = {};
  try {
    card = (await t.getCard(cardId, undefined, { board })) ?? {};
  } catch {
    /* degrade to url only */
  }
  const url = card.url || `https://trello.com/c/${cardId}`;
  const brief = q.slice(0, 300);
  const pingText = card.name
    ? `🏭 Factory needs you — card ${card.name}: ${brief} — reply with a comment on ${url}`
    : `🏭 Factory needs you — ${brief} — reply with a comment on ${url}`;
  let discord;
  try {
    discord = (await notify({ text: pingText })) ?? { sent: true };
  } catch (e) {
    discord = { error: String(e?.message ?? e) };
  }

  const base = { card: cardId, asked: true, askCommentId, discord };
  if (noWait) return { ...base, replied: false, noWait: true, polls: 0, waitedMs: 0 };
  const polled = await pollForReply({
    cardId,
    sinceDate,
    excludeCommentId: askCommentId,
    timeoutMs,
    intervalMs,
    board,
    t,
    sleep,
    now,
  });
  return { ...base, ...polled };
}

/**
 * Resume half: block for a human reply (author-based; the `[HUMAN]` tag is an
 * optional fast-path) WITHOUT posting/pinging again.
 * Replies are matched by date (not "new since last poll"), so comments that
 * landed before this process started are found on the first poll.
 * `sinceIso` defaults to process start (now()).
 * → { replied:true, reply, polls, waitedMs } | { replied:false, timedOut:true, polls, waitedMs }
 */
export async function waitForHuman({
  cardId,
  sinceIso,
  timeoutMs = envNum('FACTORY_ASK_TIMEOUT_MS', 3_600_000),
  intervalMs = envNum('FACTORY_ASK_POLL_MS', 30_000),
  board = undefined, // FM-2 per-board pass-through, docs/factory-migration.md §4.3
  t = trello,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString(),
}) {
  const sinceDate = normalizeIso(sinceIso) || now();
  return pollForReply({ cardId, sinceDate, timeoutMs, intervalMs, board, t, sleep, now });
}
