# factory

Self-operating software factory: a Trello-driven pipeline that plans, implements, reviews, ships, and verifies cards across registered repos.

## Deploys

The authoritative spec is [docs/factory.md § "Deploy drivers (per-repo)"](docs/factory.md#deploy-drivers-per-repo). Each repo deploys through its registered `deploy.driver` — `docker-ssh` for discord-bot prod, `self` for the factory runtime. The `[DEPLOY]`/`[VERIFY:*]`/`[ROLLBACK]` comment contract is identical across drivers; only the runners differ.

The command lines below are reproduced verbatim from `deployCommands()` in `scripts/lib/factory-registry.js` — keep them character-exact with the code so this quick reference cannot drift from the runner.

### docker-ssh (discord-bot prod) — run from the discord-bot checkout

- `build: node scripts/deploy.js build master`
- `deploy: node scripts/deploy.js deploy <sha>`
- `rollback (after [VERIFY:FAIL]): node scripts/deploy.js rollback`
- `verify: node scripts/verify-deploy.js`

### self (factory runtime) — run from the factory checkout

- `build: none — pushing to master IS the artifact`
- `deploy: node scripts/deploy-factory.js deploy (git pull --ff-only origin master in the runtime clone + detached daemon restart)`
- `rollback (after [VERIFY:FAIL]): node scripts/deploy-factory.js rollback (checkout the previous sha + restart)`
- `verify: node scripts/verify-factory.js (daemon unit active + a board poll logged after the restart)`
