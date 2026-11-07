#!/usr/bin/env node
// Software factory board CLI. Pipeline spec: docs/factory.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as t from './lib/trello.js';
import { askHuman, waitForHuman, parseFlags } from './lib/factory-ask.js';
import { runDoneWatch, pingDoneArrival } from './lib/factory-done-ping.js';
import { runCommentResumeWatch } from './lib/factory-comment-resume.js';
import { runStallSweepWatch } from './lib/factory-stall-sweep.js';
import { runAuditSeed } from './lib/factory-audit-cards.js';
import { runReviewVerify, countBounces } from './lib/factory-review-verify.js';
import { securityCheck } from './lib/factory-security-review.js';
import { PROD_LAYERS, closeProdCard, moveDoneGate } from './lib/factory-prod-close.js';
import { mergeGuard } from './lib/factory-merge-guard.js';
import { getContext, CONTEXT_STAGES } from './lib/factory-context.js';
import { runMetricsReport } from './lib/factory-metrics.js';
import { getDiffStat, classifyDiff, approvalGate } from './lib/factory-risk.js';
import { checkCommands, tipShaOf, worktreePath, runCheckSuite, checkCommentText } from './lib/factory-blocking-checks.js';
import {
  CASES_PATH,
  harvestBoard,
  harvestSeed,
  mergeCases,
  buildReviewerPrompt,
  spawnReviewerRun,
  scoreCases,
  formatReport,
} from './lib/factory-eval.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (argv) =>
  execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const [, , cmd = 'help', ...args] = process.argv;

const STAGES = ['Ready', 'Plan', 'Implement', 'Review', 'QA', 'Deploy', 'Verify', 'Done'];

const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

function parseCardId(s) {
  const m = String(s ?? '').match(t.CARD_ID_RE);
  if (!m) die(`Not a Trello card id or URL: ${s}`);
  return m[0].toLowerCase();
}

async function findList(name) {
  const lists = await t.getLists();
  const list = lists.find((l) => !l.closed && l.name.toLowerCase() === String(name).toLowerCase());
  if (!list) die(`No open list named "${name}" on the board (run: node scripts/factory.js init)`);
  return list;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// eval-set JSONL reader (C-M11): tolerant like the eval lib's seed parser —
// missing file ⇒ [], malformed lines skipped. The eval CLI's contract path.
function readCases(path) {
  if (!existsSync(path)) return [];
  const cases = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && o.id) cases.push(o);
    } catch {
      /* malformed line: skip */
    }
  }
  return cases;
}

// Pull a boolean flag out of parseFlags' positional remainder (the value-flag
// takeValue pattern's sibling, used by eval-seed --dry / eval-run --no-spawn).
const takeFlag = (positional, name) => {
  const i = positional.indexOf(name);
  if (i === -1) return false;
  positional.splice(i, 1);
  return true;
};

const commands = {
  async init() {
    const board = await t.getBoard();
    const [lists, labels] = await Promise.all([t.getLists(), t.getLabels()]);
    const listsCreated = [];
    for (const name of STAGES) {
      if (!lists.some((l) => !l.closed && l.name.toLowerCase() === name.toLowerCase())) {
        const created = await t.createList(name, board.id);
        listsCreated.push({ id: created.id, name: created.name });
      }
    }
    let label = labels.find((l) => l.name === 'needs-human');
    if (!label) label = await t.createLabel('needs-human', 'red', board.id);
    out({ board: { id: board.id, name: board.name }, listsCreated, needsHumanLabel: label });
  },

  async status() {
    const [board, lists, cards] = await Promise.all([
      t.getBoard(),
      t.getLists(),
      t.getBoardCards(),
    ]);
    out({
      board: board.name,
      lists: lists
        .filter((l) => !l.closed)
        .sort((a, b) => a.pos - b.pos)
        .map((l) => ({
          id: l.id,
          name: l.name,
          cards: cards
            .filter((c) => c.idList === l.id)
            .map((c) => ({
              id: c.id,
              name: c.name,
              url: c.url,
              labels: c.labels.map((x) => x.name),
            })),
        })),
    });
  },

  async pull() {
    const list = await findList(args[0] || 'Ready');
    const cards = await t.getBoardCards();
    out(
      cards
        .filter((c) => c.idList === list.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          url: c.url,
          labels: c.labels.map((x) => x.name),
        })),
    );
  },

  async add() {
    const list = await findList(args[0] || 'Ready');
    const title = args.slice(1).join(' ');
    if (!title) die('Usage: factory.js add <listName> <title>');
    const card = await t.createCard(title, list.id);
    out({ id: card.id, name: card.name, list: list.name, url: card.url });
  },

  async desc() {
    const id = parseCardId(args[0]);
    let text = args.slice(1).join(' ');
    if (text === '-') text = await readStdin();
    if (!text.trim()) die('Empty description text (pass text, or "-" to read stdin)');
    const res = await t.setCardDesc(id, text);
    out({ card: id, updated: true, chars: res.desc ? res.desc.length : 0 });
  },

  async mergeable() {
    const branch = args[0] || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const target = args[1] || 'master';
    let base;
    try {
      base = git(['merge-base', target, branch]).trim();
    } catch (e) {
      die(`no merge-base between "${target}" and "${branch}": ${String(e.stderr ?? e.message).trim()}`);
    }
    const merged = git(['merge-tree', base, target, branch]);
    const conflicted = merged.includes('<<<<<<<');
    out({ branch, target, mergeBase: base.slice(0, 10), mergeable: !conflicted });
    if (conflicted) process.exit(1);
  },

  // Security footprint probe (docs/security-review.md): JSON verdict only,
  // always exit 0 — it is a TRIGGER, not a gate; the scheduler reads the JSON
  // to decide whether to spawn the security-reviewer (sensitive) or post the
  // [SEC:PASS] no-op itself (not sensitive).
  async 'security-check'() {
    const branch = args[0] || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const target = args[1] || 'master';
    out(await securityCheck({ branch, target, git }));
  },

  // Fresh-master merge guard (docs/factory.md "Scheduler loop" PRE-MERGE
  // GUARD): re-fetches origin/<target> and checks the branch's merge-base
  // against the fresh tip. GATE, unlike the security-check trigger:
  // exit 0 = safe to `git merge --ff-only`; exit 1 = master advanced (or the
  // fetch failed — fail-closed) → re-run the MERGE GATE rebase+mergeable and
  // this guard before merging.
  async 'merge-guard'() {
    if (args.length > 2) die('Usage: factory.js merge-guard <branch> [target=master]');
    const branch = args[0] || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const target = args[1] || 'master';
    const verdict = await mergeGuard({ branch, target, git });
    out(verdict);
    if (verdict.stale) process.exit(1);
  },

  // Factory + reviewer metrics reporting pass (docs/factory.md "Metrics
  // report"). Read-only over board state; posts ONE [METRICS] summary comment
  // onto the dedicated report card (created once, reused) unless --no-post
  // (zero writes of any kind — no board comment, no Discord send, no report
  // artifacts; pure dry diagnostics). --since <ISO8601> narrows the
  // window; default = last run's watermark. Prints the JSON report; exit 1
  // only when the board fetch failed (nothing to report). The standing
  // schedule is scripts/factory-metrics.js install (launchd, 6 h).
  async metrics() {
    // parseFlags keeps unknown --flags positional; --no-post lives there.
    const noPost = args.includes('--no-post');
    const { flags, positional } = parseFlags(args.filter((a) => a !== '--no-post'));
    if (positional.length) die(`Unknown metrics argument "${positional[0]}" (usage: metrics [--no-post] [--since <ISO8601>])`);
    const res = await runMetricsReport({ since: flags.sinceIso ?? null, noPost });
    out(res.report);
    if (!res.ok) process.exit(1);
  },

  async archive() {
    if (!args[0]) die('Usage: factory.js archive <listName>');
    const list = await findList(args[0]);
    await t.closeList(list.id);
    out({ archived: list.name });
  },

  async reorder() {
    const flow = ['To Do', 'Ready', 'Plan', 'Implement', 'Review', 'QA', 'Deploy', 'Verify', 'Done'];
    const lists = await t.getLists();
    const reordered = [];
    for (const [i, name] of flow.entries()) {
      const list = lists.find((l) => !l.closed && l.name.toLowerCase() === name.toLowerCase());
      if (list) {
        await t.setListPos(list.id, (i + 1) * 100);
        reordered.push(list.name);
      }
    }
    out({ reordered });
  },

  async read() {
    const id = parseCardId(args[0]);
    const [card, comments] = await Promise.all([t.getCard(id), t.getCardComments(id)]);
    out({
      ...card,
      comments: comments.map((c) => ({
        date: c.date,
        author: c.memberCreator?.fullName ?? c.memberCreator?.username ?? 'unknown',
        text: c.data?.text ?? c.text,
      })),
    });
  },

  // Curated per-stage context (docs/factory.md "Per-stage context"): the
  // stage-seeded view — description + per-stage pointers + live findings +
  // resolved-verdict digest — instead of the raw `read` dump (audit-only).
  // Unknown/missing stage → exit 1 with the valid list (prod-close's
  // unknown-layer precedent); logic lives in scripts/lib/factory-context.js.
  async context() {
    const { positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    // parseFlags keeps unknown --flags (and their values) positional; pull
    // the value flag out of the remainder by hand (prod-close precedent).
    const takeValue = (name) => {
      const i = positional.indexOf(name);
      if (i === -1) return undefined;
      const v = positional[i + 1];
      if (!v || v.startsWith('--')) die(`Missing value for ${name}`);
      positional.splice(i, 2);
      return v;
    };
    const maxChars = takeValue('--max-chars');
    if (maxChars !== undefined && (!Number.isFinite(Number(maxChars)) || Number(maxChars) <= 0))
      die(`Invalid --max-chars value: ${maxChars} (positive integer expected)`);
    const stage = String(positional[1] ?? '').toLowerCase();
    if (!stage)
      die(`Usage: factory.js context <card> <stage> (stages: ${CONTEXT_STAGES.join(' ')})`);
    // Validate BEFORE the network round-trip (prod-close's unknown-layer
    // precedent); the lib throws the same list as defense in depth.
    if (!CONTEXT_STAGES.includes(stage))
      die(`Unknown stage "${positional[1]}" — valid stages: ${CONTEXT_STAGES.join(' ')}`);
    out(await getContext({ card: id, stage, maxChars: maxChars === undefined ? undefined : Number(maxChars) }));
  },

  // Stage transition. A Done destination also DMs the owner INLINE
  // (best-effort, works with no done-watch poller running; --no-ping opts out).
  // Ping failures never change the exit code or the {card, movedTo} contract
  // the daemon parses — `donePing` is an extra key on Done moves only.
  // Done additionally enforces the [PROD-WATCH] closure gate (docs/factory.md
  // "Incident closure"): a [PROD-WATCH]-titled card refuses to move Done
  // without a [PROD-CLOSE] comment (prod-close CLI); --no-close-check opts
  // out; comment-fetch errors are fail-open (stderr note, move proceeds —
  // best-effort board reads per the Done-ping precedent).
  async move() {
    const noCloseCheck = args.includes('--no-close-check');
    const { flags, positional } = parseFlags(args.filter((a) => a !== '--no-close-check'));
    const id = parseCardId(positional[0]);
    if (!positional[1]) die('Usage: factory.js move <card> <listName>');
    const list = await findList(positional[1]);
    if (list.name.toLowerCase() === 'done' && !noCloseCheck) {
      // die() exits synchronously, so the catch below only ever sees fetch
      // errors — those are fail-open by design (best-effort board reads).
      try {
        const [gateCard, gateComments] = await Promise.all([
          t.getCard(id, 'id,name,url'),
          t.getCardComments(id),
        ]);
        const gate = moveDoneGate({ title: gateCard.name, comments: gateComments });
        if (!gate.allow) die(gate.reason);
      } catch (e) {
        console.error(`prod-close gate: comment fetch failed (${e.message}) — proceeding fail-open`);
      }
    }
    await t.moveCard(id, list.id);
    const [card, lists] = await Promise.all([
      t.getCard(id, 'id,idList,name,url'),
      t.getLists(),
    ]);
    const destName = lists.find((l) => l.id === card.idList)?.name ?? card.idList;
    if (card.idList !== list.id) die(`move did not take effect; card is in "${destName}"`);
    let donePing;
    if (list.name.toLowerCase() === 'done' && !flags.noPing) {
      // stderr: the daemon captures it in logs; stdout stays the JSON contract.
      donePing = await pingDoneArrival({
        card: { id, name: card.name, url: card.url },
        doneListId: card.idList,
        log: console.error,
      });
    }
    out({ card: id, movedTo: destName, ...(donePing ? { donePing } : {}) });
  },

  async comment() {
    const id = parseCardId(args[0]);
    let text = args.slice(1).join(' ');
    if (text === '-') text = await readStdin();
    if (!text.trim()) die('Empty comment text (pass text, or "-" to read stdin)');
    const res = await t.addComment(id, text);
    out({ card: id, comment: res.id });
  },

  // Which-layer-failed incident closure for [PROD-WATCH] cards
  // (docs/factory.md "Incident closure: which layer should have caught
  // this"): posts the [PROD-CLOSE] comment AND appends the machine-readable
  // answer to data/prod-close-seed.jsonl (the C-M11 eval seed corpus).
  // Unknown layer → exit 1 with the valid list.
  async 'prod-close'() {
    const { positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    // parseFlags keeps unknown --flags (and their values) positional; pull
    // the value flags out of the remainder by hand (seed-audit precedent).
    const takeValue = (name) => {
      const i = positional.indexOf(name);
      if (i === -1) return undefined;
      const v = positional[i + 1];
      if (!v || v.startsWith('--')) die(`Missing value for ${name}`);
      positional.splice(i, 2);
      return v;
    };
    const layer = takeValue('--layer');
    const why = takeValue('--why');
    const fix = takeValue('--fix');
    if (!layer || !why)
      die('Usage: factory.js prod-close <card> --layer <name> --why "<text>" [--fix "<text>"]');
    if (!PROD_LAYERS.includes(layer.toLowerCase()))
      die(`Unknown layer "${layer}" — valid layers: ${PROD_LAYERS.join(', ')}`);
    const res = await closeProdCard({ card: id, layer, why, fix });
    out({ card: id, comment: res.commentId, seed: res.seed });
  },

  // C-M11 eval-set harvest (docs/factory.md "Reviewer replay scoring"):
  // board bounce verdicts (live Trello — the ONLY network path here) + the
  // C-H5 prod-close seed JSONL → merged into the committed eval set with
  // id-dedupe (existing curated cases are never clobbered). New cases land
  // curated:false with the derived expected verdict as a PROPOSAL: edit the
  // file, flip curated:true, commit — that sign-off is what makes a case
  // count. --dry prints the merge result with ZERO writes; --limit N caps
  // how many board cards get their comments fetched.
  async 'eval-seed'() {
    const { positional } = parseFlags(args);
    // parseFlags keeps unknown --flags (and their values) positional; pull
    // the value flags out by hand (prod-close precedent), validate BEFORE
    // any network.
    const takeValue = (name) => {
      const i = positional.indexOf(name);
      if (i === -1) return undefined;
      const v = positional[i + 1];
      if (!v || v.startsWith('--')) die(`Missing value for ${name}`);
      positional.splice(i, 2);
      return v;
    };
    const dry = takeFlag(positional, '--dry');
    const outPath = resolve(ROOT, takeValue('--out') ?? CASES_PATH());
    const seedPathArg = takeValue('--seed');
    const limitRaw = takeValue('--limit');
    let limit;
    if (limitRaw != null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0)
        die(`Invalid --limit value: ${limitRaw} (positive integer expected)`);
    }
    const stray = positional.find((a) => String(a).startsWith('--'));
    if (stray)
      die(
        `Unknown flag "${stray}" — Usage: factory.js eval-seed [--out <path>] [--seed <path>] [--dry] [--limit N]`,
      );
    const existing = readCases(outPath);
    let cards = await t.getBoardCards();
    if (limit) cards = cards.slice(0, limit);
    const boardCandidates = await harvestBoard({ cards, commentsOf: (id) => t.getCardComments(id) });
    const seedCandidates = seedPathArg
      ? harvestSeed({ seedPath: resolve(ROOT, seedPathArg) })
      : harvestSeed();
    const candidates = [...boardCandidates, ...seedCandidates];
    const merged = mergeCases({ existing, candidates });
    const added = merged.length - existing.length;
    if (dry) {
      out({
        dryRun: true,
        out: outPath,
        boardCandidates: boardCandidates.length,
        seedCandidates: seedCandidates.length,
        added,
        merged,
      });
      return;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${merged.map((c) => JSON.stringify(c)).join('\n')}\n`);
    out({
      out: outPath,
      boardCandidates: boardCandidates.length,
      seedCandidates: seedCandidates.length,
      added,
      total: merged.length,
    });
  },

  // C-M11 improvement-loop gate (docs/factory.md "Reviewer replay scoring"):
  // replay the Reviewer role over each CURATED case via the daemon's own
  // agentArgs (FACTORY_MODEL/--max-cost env IS the comparison knob), score
  // the one-line verdicts, and gate: --min-score <baseline> exits 1 when the
  // score drops below it — run before KEEPING any prompt/model change.
  // --no-spawn re-scores stored `got` (or the historical verdictText) with
  // ZERO agent spawns (free CI smoke); spawns run one at a time.
  async 'eval-run'() {
    const { positional } = parseFlags(args);
    const takeValue = (name) => {
      const i = positional.indexOf(name);
      if (i === -1) return undefined;
      const v = positional[i + 1];
      if (!v || v.startsWith('--')) die(`Missing value for ${name}`);
      positional.splice(i, 2);
      return v;
    };
    const noSpawn = takeFlag(positional, '--no-spawn');
    const casesPath = resolve(ROOT, takeValue('--cases') ?? CASES_PATH());
    const only = takeValue('--case');
    const reportPathArg = takeValue('--out');
    const minRaw = takeValue('--min-score');
    let minScore;
    if (minRaw != null) {
      minScore = Number(minRaw);
      if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)
        die(`Invalid --min-score value: ${minRaw} (number between 0 and 1 expected)`);
    }
    const stray = positional.find((a) => String(a).startsWith('--'));
    if (stray)
      die(
        `Unknown flag "${stray}" — Usage: factory.js eval-run [--cases <path>] [--case <id>] [--out <report.json>] [--no-spawn] [--min-score <0..1>]`,
      );
    const cases = readCases(casesPath);
    if (!cases.length)
      die(`No eval cases in ${casesPath} (run: node scripts/factory.js eval-seed first)`);
    let selected = cases;
    if (only)
      selected = cases.filter((c) => String(c.id).toLowerCase() === String(only).toLowerCase());
    if (!selected.length) die(`No case with id "${only}" in ${casesPath}`);
    const verdicts = {};
    if (noSpawn) {
      for (const c of selected) verdicts[c.id] = String(c.got ?? c.verdictText ?? '');
    } else {
      for (const c of selected) {
        console.error(`eval-run: replaying case ${c.id} "${c.title ?? ''}" …`);
        let reply = '';
        try {
          const res = await spawnReviewerRun(buildReviewerPrompt(c));
          reply = res.stdout;
        } catch (e) {
          console.error(`eval-run: case ${c.id} spawn failed: ${e.message}`);
        }
        verdicts[c.id] = reply;
      }
    }
    const summary = scoreCases({ cases: selected, verdicts, ...(minScore != null ? { minScore } : {}) });
    if (reportPathArg) {
      const reportPath = resolve(ROOT, reportPathArg);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, formatReport(summary));
    }
    out(summary);
    if (minScore != null && !summary.pass) process.exit(1);
  },

  async label() {
    const id = parseCardId(args[0]);
    const name = args[1] || 'needs-human';
    const board = await t.getBoard();
    let label = (await t.getLabels()).find((l) => l.name === name);
    if (!label) label = await t.createLabel(name, 'red', board.id);
    await t.addLabelToCard(id, label.id);
    out({ card: id, label: label.name });
  },

  async watch() {
    const intervalMs = Number(process.env.FACTORY_POLL_MS || 15000);
    const list = await findList(args[0] || 'Ready');
    const known = new Set(
      (await t.getBoardCards()).filter((c) => c.idList === list.id).map((c) => c.id),
    );
    console.log(`watching "${list.name}" every ${intervalMs}ms (${known.size} cards already known)`);
    for (;;) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const cards = (await t.getBoardCards()).filter((c) => c.idList === list.id);
      for (const c of cards) {
        if (!known.has(c.id)) {
          known.add(c.id);
          console.log(`NEW ${c.id} ${c.name}`);
        }
      }
    }
  },

  // Ask a human: post [ASK] + Discord ping, then block for the human reply
  // (author-based; the [HUMAN] tag is an optional fast-path).
  // Protocol: docs/factory.md ("Asking a human"). Timeout → exit 1 (bounce/park).
  async ask() {
    const { flags, positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    let question = positional.slice(1).join(' ');
    if (question === '-') question = await readStdin();
    if (!question.trim())
      die('Usage: factory.js ask <card> <question|-> [--timeout <ms>] [--interval <ms>] [--no-wait]');
    const res = await askHuman({ cardId: id, question, ...flags });
    out(res);
    if (res.timedOut) process.exit(1);
  },

  // Resume half of the ask protocol: wait for the human reply without
  // posting/pinging again (ask once, wait many times — survives restarts).
  async wait() {
    const { flags, positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    const res = await waitForHuman({ cardId: id, ...flags });
    out(res);
    if (res.timedOut) process.exit(1);
  },

  // Done-list pinger: DM the owner once per card arrival in Done (list-diff
  // poller; covers scheduler moves AND human UI drags). Dedup state persists in
  // data/factory-done-ping.json — restarts never re-ping. Semantics:
  // docs/factory.md ("Pinging on Done"). Continuous mode is a service: logs
  // only; --once runs one cycle and prints the JSON result.
  async 'done-watch'() {
    const { flags, positional } = parseFlags(args);
    const res = await runDoneWatch({ listName: positional[0] || 'Done', ...flags });
    if (flags.once) out(res);
  },

  // Comment listener: resume in-flight cards a human commented on while no
  // run owned them (the stuck-Verify fix). Posts a [RESUME] ack, then spawns
  // a scheduler run seeded at the card's CURRENT stage — never back to Plan.
  // Semantics: docs/factory.md ("Listening for human comments"). The daemon
  // auto-runs and supervises this poller in-process; run it by hand only for
  // diagnostics (same double-poller warning as done-watch). --once runs one
  // cycle and prints the JSON result; --dry-run reports would-resume cards
  // with ZERO board writes and ZERO state writes (safe alongside the daemon).
  async 'resume-watch'() {
    const { flags } = parseFlags(args);
    const res = await runCommentResumeWatch({ ...flags });
    if (flags.once) out(res);
  },

  // Stall sweep: recover in-flight cards stranded by an exit-0-without-
  // advance run or a daemon restart — silent past FACTORY_MAX_TIME + 15 min
  // (silence window FACTORY_STALL_SILENCE_MS), through the daemon's crash
  // machinery (resume/requeue/park + comment-derived crash cap). Semantics:
  // docs/factory.md ("Auto-start daemon" — stall recovery). The daemon runs
  // this at boot and supervised in-process; run a LIVE sweep by hand only on
  // a daemon-less board (double-spawn warning). --once runs one cycle and
  // prints the JSON result; --dry-run reports would-resume + ask-pending
  // holds with ZERO writes — safe alongside the live daemon.
  async 'stall-sweep'() {
    const { flags } = parseFlags(args);
    const res = await runStallSweepWatch({ ...flags });
    if (flags.once) out(res);
  },

  // Risk tier of a branch diff (git-only, ZERO board writes): merge-base vs
  // branch numstat → tier rules in scripts/lib/factory-risk.js (spec:
  // docs/factory.md "Risk-tiered approval before Deploy"). Informational —
  // exit 0 on any diff; dies only when git itself fails (bad refs).
  async risk() {
    const branch = args[0] || 'HEAD';
    const target = args[1] || 'origin/master';
    let stat;
    try {
      stat = getDiffStat({ branch, target });
    } catch (e) {
      die(`risk diff failed for "${branch}" against "${target}": ${String(e.stderr ?? e.message).trim()}`);
    }
    const cls = classifyDiff(stat.files);
    out({ branch, target, mergeBase: stat.mergeBase, tier: cls.tier, reasons: cls.reasons, files: cls.files, additions: cls.additions, deletions: cls.deletions });
  },

  // Risk gate: exit 0 when the card's sha may be merged+deployed — tier low
  // passes with ZERO board writes; medium/high need a human (never bot) card
  // comment containing THIS sha. Unapproved → one [ASK]+ping, then block on
  // the ask protocol until approval or timeout. Timeout → exit 1 → the
  // scheduler labels needs-human and parks the card in QA (NOT a bounce);
  // recovery = approve late on the card, drag back to Ready (the re-run's
  // scan finds the comment). Spec: docs/factory.md "Risk-tiered approval
  // before Deploy"; protocol reuse: "Asking a human".
  async approve() {
    const { flags, positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    const sha = String(positional[1] ?? '').toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha))
      die('Usage: factory.js approve <card> <sha> [branch] [--timeout <ms>] [--interval <ms>]  (sha = 7-40 hex chars — the QA-passed HEAD)');
    const branch = positional[2] || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const res = await approvalGate({ cardId: id, sha, branch, ...flags });
    out(res);
    process.exit(res.approved ? 0 : 1);
  },

  // Independent blocking-checks gate (docs/factory.md "Independent blocking
  // checks"): deterministic one-shot reproduction of the daemon poller for
  // ONE card — run the blocking suite (`npm test` as package.json defines
  // it; FACTORY_CHECK_CMD override) against the card's worktree tip, post
  // the [CHECK:PASS]/[CHECK:FAIL] verdict comment, print JSON, exit 0/1
  // mirroring the suite. It NEVER moves the card (the daemon gate owns the
  // bounce move; the scheduler owns moves). Operator/debug tool, same
  // spirit as security-check.
  async 'blocking-checks'() {
    if (!args[0]) die('Usage: factory.js blocking-checks <card>');
    const id = parseCardId(args[0]);
    const sha = tipShaOf(`factory/${id}`);
    if (!sha) die(`no branch factory/${id} (nothing to check — run the factory pipeline first)`);
    const worktree = worktreePath(id);
    if (!existsSync(worktree)) die(`no worktree at ${worktree} (nothing to check)`);
    const commands = checkCommands();
    const { pass, results } = await runCheckSuite({ worktree, commands });
    await t.addComment(id, checkCommentText({ pass, sha, results }));
    out({
      card: id,
      sha,
      pass,
      results: results.map((r) => ({ cmd: r.cmd, exit: r.exit })),
    });
    if (!pass) process.exit(1);
  },

  // Seed one card per docs/factory-audit.md Section C finding into a list
  // (default To Do — inert to the daemon, which only dispatches Ready), each
  // with its High/Medium/Low priority label and the full bullet as description.
  // Dedup is title-based against the whole board → re-runs create 0 cards.
  // --dry-run reports the plan with ZERO board writes. Semantics:
  // scripts/lib/factory-audit-cards.js header.
  async 'seed-audit'() {
    const { flags, positional } = parseFlags(args);
    // parseFlags keeps unknown --flags (and their values) positional; pull the
    // two value flags out of the remainder by hand.
    const takeValue = (name) => {
      const i = positional.indexOf(name);
      if (i === -1) return undefined;
      const v = positional[i + 1];
      if (!v || v.startsWith('--')) die(`Missing value for ${name}`);
      positional.splice(i, 2);
      return v;
    };
    const listName = takeValue('--list') ?? 'To Do';
    const docPath = takeValue('--doc');
    // stderr for the CREATED/SKIP progress lines: stdout stays the JSON contract.
    const res = await runAuditSeed({ listName, docPath, dryRun: flags.dryRun, log: console.error });
    out(res);
    if (!res.ok) process.exit(1);
  },

  // Review-verify sub-step (docs/factory.md "Verifying reviewer findings"):
  // applies the per-finding verifier classifications to the latest
  // [REVIEW:VERIFY]-eligible [REVIEW:CHANGES], posts exactly one
  // [REVIEW:VERIFY] verdict comment, prints the routing verdict JSON.
  // decision=bounce|proceed is ROUTING → exit 0 either way; misuse (no
  // [REVIEW:CHANGES], bad JSON payload, unknown index/verdict) exits 1 so a
  // broken classifications payload can never silently proceed.
  async 'review-verify'() {
    const id = parseCardId(args[0]);
    let raw = args[1];
    if (raw === '-') raw = await readStdin();
    if (!raw || !raw.trim())
      die('Usage: factory.js review-verify <card> <classesJson|->  (JSON array [{index,verdict,why}]; "-" reads stdin)');
    let classifications;
    try {
      classifications = JSON.parse(raw);
    } catch (e) {
      die(`classifications payload is not valid JSON: ${e.message}`);
    }
    const res = await runReviewVerify({ cardId: id, classifications });
    out(res);
  },

  // Bounce counter (needs-human gate reads code, not LLM arithmetic):
  // (# [REVIEW:CHANGES] whose [REVIEW:VERIFY] says bounce + # [REVIEW:CHANGES]
  // with no [REVIEW:VERIFY] yet + # [SEC:FINDINGS] + # [QA:FAIL] +
  // # [VERIFY:FAIL]). Read-only.
  async bounces() {
    const id = parseCardId(args[0]);
    out(await countBounces(await t.getCardComments(id)));
  },

  async help() {
    process.stdout.write(
      [
        'Software factory board CLI (spec: docs/factory.md)',
        '',
        '  init                        ensure factory lists + needs-human label',
        '  status                      board snapshot JSON',
        '  pull [Ready]                cards in a list',
        '  add [Ready] <title>         create a card in a list',
        '  desc <card> <text|->        set card description ("-" reads stdin)',
        '  read <cardIdOrUrl>          card name, description, comments',
        '  context <card> <stage> [--max-chars <n>]  curated per-stage context JSON (stages: plan implement review security qa deploy verify); exit 1 on unknown stage',
        '  move <card> <listName> [--no-ping] [--no-close-check]  stage transition; a Done target DMs the owner inline and enforces the [PROD-WATCH] closure gate',
        '  comment <card> <text|->     post stage comment ("-" reads stdin)',
        '  prod-close <card> --layer <name> --why "<text>" [--fix "<text>"]',
        '      [PROD-CLOSE] closure for [PROD-WATCH] cards: which layer should have',
        '      caught this + JSONL seed for C-M11 (layers: plan implement review',
        '      security qa deploy verify prod-watch infra unknown)',
        '  eval-seed                   harvest bounce verdicts + the prod-close seed JSONL into eval/cases.jsonl (C-M11)',
        '      [--out <path>] [--seed <path>] [--dry] [--limit N]  (--dry = print the merge, zero writes; new cases land curated:false — flip curated:true to score them)',
        '  eval-run                    replay the Reviewer role over the curated eval set and score it (C-M11)',
        '      [--cases <path>] [--case <id>] [--out <report.json>] [--no-spawn] [--min-score <0..1>]  (--min-score = keep-gate for a prompt/model change; --no-spawn scores stored got, zero agent spawns)',
        '  ask <card> <question|->     post [ASK] + Discord ping, wait for the human reply',
        '      [--timeout <ms>] [--interval <ms>] [--no-wait]  (defaults 1h / 30s)',
        '  wait <card>                 resume waiting for the human reply (no post/ping)',
        '      [--since <ISO8601>] [--timeout <ms>] [--interval <ms>]',
        '  label <card> [needs-human]  attach a label (creates it if missing)',
        '  mergeable <br> <target>     git-flow gate: clean merge? (exit 1 if conflicts)',
        '  security-check <br> <target>   security footprint probe: JSON {securitySensitive, matchedPaths} (exit 0)',
        '  merge-guard <br> [target=master]  fresh-master gate: fetch origin/<target>, merge-base(origin/<target>, <br>) == tip?',
        '      JSON {stale, testedBase, masterTip, action}; exit 0 merge / exit 1 re-gate (fetch failure fail-closed)',
        '  metrics [--no-post] [--since <ISO8601>]  factory+reviewer metrics report (JSON); default posts one [METRICS] summary onto the report card',
        '  risk <branch> [target]      risk tier from the branch diff (exit 0; default HEAD vs origin/master)',
        '  approve <card> <sha> [branch]  risk gate: exit 0 when low tier OR a human comment keys THIS sha',
        '      [--timeout <ms>] [--interval <ms>]  (defaults FACTORY_APPROVAL_TIMEOUT_MS/1h / FACTORY_ASK_POLL_MS/30s)',
        '  archive <listName>          close (archive) a list',
        '  reorder                     order lists: To Do→Ready→…→Done',
        '  watch [Ready]               poll a list; print "NEW <id> <name>" lines',
        '  done-watch [Done]           poll the Done list; DM the owner once per arrival',
        '      [--interval <ms>] [--once]  (default FACTORY_DONE_POLL_MS/15s; --once = one check)',
        '  resume-watch                resume in-flight cards with new human comments',
        '      [--interval <ms>] [--once] [--dry-run]  (default FACTORY_RESUME_POLL_MS/15s; --dry-run = report only, no board/state writes)',
        '  stall-sweep                 recover stalled/orphaned in-flight cards (silent past FACTORY_MAX_TIME+grace)',
        '      [--interval <ms>] [--once] [--dry-run]  (default FACTORY_STALL_POLL_MS/300s; --dry-run = report only, zero writes, safe alongside the daemon; never run a live sweep alongside it)',
        '  blocking-checks <card>      daemon gate one-shot: run the blocking suite (npm test;',
        '      FACTORY_CHECK_CMD override) against factory/<card> worktree tip, post the',
        '      [CHECK:PASS]/[CHECK:FAIL] verdict comment, print JSON, exit 0/1 mirroring the suite (never moves the card)',
        '  seed-audit                  create one card per docs/factory-audit.md Section C finding',
        '      [--dry-run] [--list <name>] [--doc <path>]  (default list: To Do; title-dedup makes re-runs create 0)',
        '  review-verify <card> <classesJson|->  apply per-finding verifier classifications',
        '      to the latest [REVIEW:CHANGES], post [REVIEW:VERIFY], print the verdict JSON (exit 1 on misuse)',
        '  bounces <card>              bounce count JSON {bounces,cap,park,breakdown} — the needs-human ≥3 gate',
        '',
      ].join('\n'),
    );
  },
};

const run = commands[cmd];
if (!run) die(`Unknown command "${cmd}" (try: node scripts/factory.js help)`);
run().catch((e) => die(e.message));
