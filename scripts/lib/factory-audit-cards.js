// Audit-finding seeder for the software factory (card 6ae9630ebf8a6f1275923111).
// CLI: `node scripts/factory.js seed-audit` (docs/factory.md CLI section).
//
// Reads `docs/factory-audit.md` Section C — Prioritized improvement list at run
// time (nothing hardcoded — the doc is the state) and creates exactly one
// Trello card per finding in the target list (default `To Do`; the live daemon
// only dispatches `Ready`, so To Do cards are inert), each carrying the
// priority label (High/Medium/Low) and the finding's full raw bullet as the
// description. The combined `C-H6 / C-M13` bullet is ONE finding — one card.
//
// Idempotency: card names are deterministic (`"<id> — <title>"`) and every
// create is deduped against the names of ALL open board cards first, so a
// re-run creates zero cards even if a human already moved one out of To Do.
// Deliberate drift trade-off: editing a finding's title text later makes a
// re-run create one new card for that finding (the board itself is the state —
// same philosophy as the rest of the factory; no state file).
//
// Labels are ensured here, NOT via `factory.js label` (which auto-creates every
// missing label in red — three priorities would share one color): High=red,
// Medium=orange, Low=green, reused by exact name when already present.
//
// Dependency-injectable logic, the factory-done-ping.js pattern: every seam
// (trello client, doc reader, log) defaults to the real thing and is faked in
// tests/factoryAuditCards.test.js — zero live Trello there.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Priority label name → Trello label color (all valid; distinct colors). */
export const PRIORITY_LABELS = { High: 'red', Medium: 'orange', Low: 'green' };

// `- **C-H1 — Title** (refs). *Why:* …` — the id group also accepts the
// combined `C-H6 / C-M13` form; title = bolded text before the first `**`.
const BULLET_RE = /^- \*\*(C-[A-Z]\d+(?: \/ C-[A-Z]\d+)?) — (.+?)\*\*/;
const SUBSECTION_RE = /^###\s+(High|Medium|Low)\b/i;

/**
 * Parse Section C findings out of the audit markdown. Pure — no IO.
 * Returns [{ id, title, name, priority, description }] in document order.
 * Throws on: no Section C heading, zero findings in scope (fail loud rather
 * than silently seed 0 cards), or two bullets deriving the same title.
 */
export function parseSectionC(md) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Section C\b/.test(l));
  if (start === -1) throw new Error('No "## Section C" heading found in the audit doc');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const findings = [];
  let priority = null; // set by `### High|Medium|Low`; bullets outside a known subsection are ignored
  for (let i = start; i < end; i++) {
    const head = lines[i].match(SUBSECTION_RE);
    if (head) {
      priority = head[1].charAt(0).toUpperCase() + head[1].slice(1).toLowerCase();
      continue;
    }
    const m = lines[i].match(BULLET_RE);
    if (!m || !priority) continue;
    const [, id, title] = m;
    findings.push({
      id,
      title,
      name: `${id} — ${title}`, // deterministic card name — doubles as the dedup key
      priority,
      description: lines[i].replace(/^- /, ''), // full raw bullet, minus the leading "- "
    });
  }
  if (findings.length === 0) {
    throw new Error('Section C contains no "- **C-… — …**" finding bullets — refusing to seed 0 cards');
  }
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.name)) throw new Error(`Duplicate Section C finding title: "${f.name}"`);
    seen.add(f.name);
  }
  return findings;
}

/**
 * Ensure open labels named exactly High/Medium/Low exist on the board
 * (PRIORITY_LABELS colors); reuse any that already exist by name.
 * Returns { High: labelId, Medium: labelId, Low: labelId }.
 */
export async function ensurePriorityLabels({ t = trello, boardId } = {}) {
  const labels = await t.getLabels();
  const ids = {};
  for (const [name, color] of Object.entries(PRIORITY_LABELS)) {
    let label = labels.find((l) => l.name === name);
    if (!label) label = await t.createLabel(name, color, boardId);
    ids[name] = label.id;
  }
  return ids;
}

/**
 * Seed the board with one card per Section C finding. Sequential writes
 * (rate-limit-friendly). dryRun reports the full plan with ZERO board writes.
 * Returns { ok, list, parsed, created[], skipped[], counts, labels } (live) or
 * { ok, dryRun, list, parsed, wouldCreate[], wouldSkip[], labelColors } (dry).
 * Rejects on missing target list or parse errors; the CLI turns that into exit 1.
 */
export async function runAuditSeed({
  t = trello,
  docPath = resolve(ROOT, 'docs', 'factory-audit.md'),
  listName = 'To Do',
  dryRun = false,
  readDoc = (p) => readFileSync(p, 'utf8'),
  log = console.log,
} = {}) {
  const parsed = parseSectionC(readDoc(docPath));
  const lists = await t.getLists();
  const list = lists.find(
    (l) => !l.closed && l.name.toLowerCase() === String(listName).toLowerCase(),
  );
  if (!list) throw new Error(`No open list named "${listName}" on the board`);
  // Dedup against EVERY open card name on the board — survives mid-rerun
  // stage moves (a card the human already dragged to Ready must not be re-created).
  const existing = new Set(
    (await t.getBoardCards('id,name,idList')).map((c) => String(c.name).trim()),
  );
  const names = parsed.map((f) => f.name);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      list: list.name,
      parsed: parsed.length,
      wouldCreate: names.filter((n) => !existing.has(n)),
      wouldSkip: names.filter((n) => existing.has(n)),
      labelColors: PRIORITY_LABELS,
    };
  }
  const board = await t.getBoard();
  const labels = await ensurePriorityLabels({ t, boardId: board.id });
  const created = [];
  const skipped = [];
  for (const f of parsed) {
    if (existing.has(f.name)) {
      skipped.push(f.name);
      log(`SKIP ${f.name}`);
      continue;
    }
    // One POST carries name + list + description; the label ride-along after.
    const card = await t.createCard(f.name, list.id, f.description);
    await t.addLabelToCard(card.id, labels[f.priority]);
    created.push({ name: f.name, id: card.id, list: list.name, label: f.priority });
    log(`CREATED ${f.name}`);
  }
  return {
    ok: true,
    list: list.name,
    parsed: parsed.length,
    created,
    skipped,
    counts: { created: created.length, skipped: skipped.length },
    labels,
  };
}
