# Area: memory/embeddings

## Area

`service/ai/memory/` (extract, factStore, retrieve, embedder,
vectorSearch, vectorMath, schema, conflict, tokens, memoryManager,
memoryCommands), plus `scripts/migrateMemoryV1.js`,
`scripts/backfillMemoryFromExport.js`, the `scripts/memory*.mjs`
one-shot probes, and the `scripts/fuzz*` / `scripts/calibrate*` tuning
scripts, and the `tests/memory*.test.js` suite.

## Failure mode

The bot persists a wrong or leaked fact, or crashes on schema/vector
drift. Typical bad changes: a SQLite schema/migration mismatch that
loses memory silently between deploys (old DBs stop loading), an
embedding dimension change that breaks `vectorSearch` against the
vectors already stored, or a dedupe regression that stores the same
fact twice. None of these fail loudly at merge time — they surface in
prod after a deploy.

## Must-check behaviors

- Migrations in `migrateMemoryV1.js` / `schema.js` are
  backward-compatible: an existing prod DB must still load and upgrade
  after the change.
- Embedder changes keep the embedding dimension compatible with stored
  vectors or carry a re-embed path.
- Extract/retrieve paths still honor the config kill-switches — verify
  the change consults the config flags rather than bypassing them.
- Persona/multi-bot isolation is preserved: `multiBotMemoryIsolation`
  semantics must not silently change.

## Paths to skip

Style-only nits on the `scripts/memory*.mjs` one-shot probes and the
`scripts/fuzz*` / `calibrate*` tuning scripts are not findings;
behavior findings in those files are still welcome.

## Evidence format

Every finding cites `file:line`, states the behavior broken, and names
which test in `tests/memory*.test.js` proves it — or which test would
prove it and is missing.

## Nit cap

At most 3 style nits per `[REVIEW:CHANGES]` verdict comment for this
area; substance over style.
