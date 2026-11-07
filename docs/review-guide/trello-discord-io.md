# Area: Trello/Discord I/O

## Area

`scripts/lib/trello.js`, `scripts/factory.js`,
`scripts/factory-daemon.js`, `scripts/lib/factory-ask.js`,
`scripts/lib/factory-done-ping.js`,
`scripts/lib/factory-comment-resume.js`, `index.js` (Discord inbound),
`service/interactionAdapter.js`, `service/ai/requestLog.js`,
`service/resilience.js`, `service/ai/multiBotRouting.js`.

## Failure mode

The board state machine is corrupted or Discord replies never arrive:
a wrong list move, a duplicated first-token comment, or a missed
`[IMPL]` invalidates the scheduler's gates; identity checks that fail
open on bot-authored comments let a human comment slip past — or a bot
comment get treated as human; watermark/state-file corruption silently
halts or replays the poller. These failures break pipeline contracts
other cards depend on, not just this card's feature.

## Must-check behaviors

- Comment posting keeps the first-token contract: whatever tag the diff
  posts must remain the comment's first token (Board contract).
- Trello move/label calls keep the only-the-scheduler-moves rule —
  stage agents never move cards.
- ask/done/resume identity logic stays fail-closed on lookup failure:
  when bot authorship cannot be confirmed, the code must not act as if
  it knew.
- State files (`data/factory-*.json`) keep atomic-write and dedup
  semantics.

## Paths to skip

Cosmetic comment-string edits in `scripts/factory.js` help text;
persona wording in `service/ai/multiBotRouting.js`.

## Evidence format

Every finding cites `file:line`, names which board-contract invariant
in `docs/factory.md` breaks, and shows the observed versus expected
comment or state-file shape.

## Nit cap

At most 2 style nits per `[REVIEW:CHANGES]` verdict comment for this
area.
