# Review Guide — per-area review ground truth

These are owner-written per-area review ground-truth documents: what a
bad change looks like in each part of this repo, what a reviewer MUST
verify there, which paths are nit-free zones, and what evidence a
finding in that area must carry. The Review stage applies them per
`docs/factory-prompts/reviewer.md` ("Area review ground-truth docs").

- **Path map:** the table below is the single source of truth for which
  paths belong to which area — the reviewer maps `git diff --name-only
  master...factory/<card-id>` output against it before judging a diff.
- **Ownership:** the area docs own what matters in their area;
  `docs/factory-prompts/reviewer.md` owns when and how to apply them;
  the Board contract in `docs/factory.md` still owns the tag set and
  gate logic. The cadence pointer lives in `docs/factory.md`'s "Review
  ground truth (per-area docs)" section.

## Path → area map

| Area | Doc | Matches (repo-relative path prefixes) |
| --- | --- | --- |
| memory/embeddings | `memory-embeddings.md` | `service/ai/memory/`, `scripts/migrateMemoryV1.js`, `scripts/backfillMemoryFromExport.js`, `scripts/calibrate*`, `scripts/fuzz*`, `scripts/memory*.mjs`, `tests/memory*` |
| deploy/SSH | `deploy-ssh.md` | `scripts/deploy.js`, `scripts/verify-deploy.js`, `scripts/prod-watch.js`, `scripts/lib/deploy-`, `scripts/deploy-host-logs.sh`, `scripts/provision-deploy-host.sh`, `Dockerfile`, `docker-compose.yml`, `config/`, `docs/deploy-host.md` |
| Trello/Discord I/O | `trello-discord-io.md` | `scripts/lib/trello.js`, `scripts/factory.js`, `scripts/factory-daemon.js`, `scripts/lib/factory-ask.js`, `scripts/lib/factory-done-ping.js`, `scripts/lib/factory-comment-resume.js`, `index.js`, `service/interactionAdapter.js`, `service/ai/requestLog.js`, `service/resilience.js`, `service/ai/multiBotRouting.js` |

Paths matching no row are judged on the general rules in
`docs/factory-prompts/reviewer.md` alone.

## Spot-check ritual

Reviewer findings are expected to follow these docs — compliance is
itself checked. Cadence: **after every 10 merged cards or monthly,
whichever comes first** (the operator runs it; the merged-card count
comes from `node scripts/factory.js pull Done`).

1. Take the last 5 cards that passed Review and read each card's
   comments: `node scripts/factory.js read <card-id>`.
2. For each card verify:
   - (a) the `[REVIEW:APPROVE]` / `[REVIEW:CHANGES]` verdict comment
     names the area ground-truth docs applied (or `no area doc
     matched`);
   - (b) every `[REVIEW:CHANGES]` finding cites `file:line` per the
     matched area's evidence format;
   - (c) no finding lands on a path the matched area lists under Paths
     to skip;
   - (d) full-pass verdicts address the matched areas' must-check
     behaviors.
3. Append a dated one-line result to the **Spot-check log** below —
   committed to the repo; the git history is the audit trail.
4. If a non-compliant pattern is worth fixing, open a Ready card with
   `node scripts/factory.js add` naming the area doc and the miss, so
   the fix flows through the factory itself. (The eventual C-L1 nightly
   sweep may subsume this ritual.)

## Spot-check log

- 2026-11-03 — ritual established by C-M6; no checks run yet.
