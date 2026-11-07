// Which-layer-failed incident closure for `[PROD-WATCH]` cards (card
// 6ae9676d2461fd41204b507e; docs/factory.md "Incident closure: which layer
// should have caught this").
//
// Root cause this fixes: prod-watch incident cards close with no structured
// root-cause attribution, so the answer to "which layer should have caught
// this?" can never seed the C-M11 eval set. Every `[PROD-WATCH]` outage /
// bad-deploy card must carry exactly one `[PROD-CLOSE]` comment answering it
// BEFORE the card moves to Done; `factory.js prod-close` posts the comment AND
// appends the machine-readable answer to data/prod-close-seed.jsonl (one JSON
// line per closed incident — C-M11's seed corpus). `data/` is gitignored, so
// the file is a runtime append, never committed.
//
// The Done move is gated mechanically: `factory.js move <card> Done` refuses
// (exit 1) for `[PROD-WATCH]`-titled cards with no `[PROD-CLOSE]` comment
// (`--no-close-check` opts out; comment-fetch errors are fail-open in the CLI,
// mirroring the Done-ping best-effort precedent). UI drags are ungated by
// nature — docs carry the convention for human closures.
//
// Dependency-injectable logic, the factory-done-ping.js pattern: the trello
// client and the seed append default to the real thing and are faked in
// tests/factoryProdClose.test.js — zero live Trello there.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Seed corpus path (test-overridable like the STATE_PATH siblings). */
export const SEED_PATH = () => resolve(ROOT, 'data', 'prod-close-seed.jsonl');

/**
 * Layer taxonomy — the one enum the CLI, the docs and C-M11 share. Named
 * after the layers as deployed: `prod-watch` means detector latency / no
 * earlier layer could catch it; `infra` means host/DHCP/power — no pipeline
 * layer applies.
 */
export const PROD_LAYERS = [
  'plan',
  'implement',
  'review',
  'security',
  'qa',
  'deploy',
  'verify',
  'prod-watch',
  'infra',
  'unknown',
];

/** True when the card title opens with `[PROD-WATCH]` (case-insensitive). */
export function isProdWatchCard(name) {
  return /^\[PROD-WATCH\]/i.test(String(name ?? '').trim());
}

/**
 * The `[PROD-CLOSE]` comment text (first token `[PROD-CLOSE]`). Throws on a
 * layer outside PROD_LAYERS — the JSONL must stay machine-usable for C-M11.
 */
export function prodCloseText({ layer, why, fix } = {}) {
  const l = String(layer ?? '').trim().toLowerCase();
  if (!PROD_LAYERS.includes(l)) {
    throw new Error(`Unknown layer "${layer}" — valid layers: ${PROD_LAYERS.join(', ')}`);
  }
  const whyLine = String(why ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!whyLine) throw new Error('prod-close needs a one-line --why (the layer missed it because…)');
  const fixLine = String(fix ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `[PROD-CLOSE] which-layer=${l} — ${whyLine} (fix: ${fixLine || 'n/a'})`;
}

/** Real seed append: mkdir -p data/ + one JSON line. Exported for injection. */
export function defaultAppendSeed(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

// Same tolerant first-token match as isStageTagText / isAskText: accepts a raw
// string OR an action/comment object (`{ data: { text } }`).
const textOf = (a) =>
  typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? '');

/** True when any comment's first token is `[PROD-CLOSE]` (case-insensitive). */
export function hasProdClose(comments) {
  const list = Array.isArray(comments) ? comments : [];
  return list.some((c) => /^\[PROD-CLOSE\]/i.test(textOf(c).trim()));
}

/**
 * Pure Done-move gate — `[PROD-WATCH]`-titled card with no `[PROD-CLOSE]`
 * comment refuses unless `noCloseCheck`; every other shape allows.
 * `comments` = trello.js `getCardComments` items (or raw strings).
 */
export function moveDoneGate({ title, comments, noCloseCheck } = {}) {
  if (noCloseCheck) return { allow: true, reason: null };
  if (!isProdWatchCard(title)) return { allow: true, reason: null };
  if (hasProdClose(comments)) return { allow: true, reason: null };
  return {
    allow: false,
    reason:
      `[PROD-WATCH] card must answer "which layer should have caught this" before Done — ` +
      `post it with: node scripts/factory.js prod-close <card> --layer <${PROD_LAYERS.join('|')}> --why "<text>" [--fix "<text>"] ` +
      `(or move with --no-close-check to opt out)`,
  };
}

/**
 * Close a `[PROD-WATCH]` incident: validate the layer, post the
 * `[PROD-CLOSE]` comment, append the JSONL seed line, return
 * `{ commentId, seed }`. Throws on unknown layer / missing why (CLI: exit 1).
 * `card` = card id (fetches name/url) or a `{ id, name, url }` object.
 */
export async function closeProdCard({
  card,
  layer,
  why,
  fix,
  ts = new Date().toISOString(),
  t = trello,
  appendSeed = defaultAppendSeed,
  seedPath = SEED_PATH(),
} = {}) {
  const id = typeof card === 'object' ? card?.id : card;
  if (!id) throw new Error('prod-close needs a card id');
  const l = String(layer ?? '').trim().toLowerCase();
  if (!PROD_LAYERS.includes(l)) {
    throw new Error(`Unknown layer "${layer}" — valid layers: ${PROD_LAYERS.join(', ')}`);
  }
  const meta = typeof card === 'object' && card?.name ? card : await t.getCard(id, 'id,name,url');
  const text = prodCloseText({ layer: l, why, fix });
  const comment = await t.addComment(id, text);
  const seed = {
    ts,
    card: id,
    url: meta?.url ?? null,
    title: meta?.name ?? null,
    layer: l,
    why: String(why ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    fix: String(fix ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  };
  appendSeed(seedPath, JSON.stringify(seed));
  return { commentId: comment?.id ?? null, seed };
}
