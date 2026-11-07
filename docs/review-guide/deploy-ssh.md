# Area: deploy/SSH

## Area

`scripts/deploy.js`, `scripts/verify-deploy.js`, `scripts/prod-watch.js`,
`scripts/lib/deploy-config.js`, `scripts/lib/deploy-ssh.js`,
`scripts/deploy-host-logs.sh`, `scripts/provision-deploy-host.sh`,
`Dockerfile`, `docker-compose.yml`, `config/`, `docs/deploy-host.md`.

## Failure mode

A broken image reaches prod, or a rollback cannot run when it is needed.
Typical bad changes: a wrong SSH target, path, env value, or secret
handling in `deploy.js` / `deploy-config.js` / `deploy-ssh.js`; a
malformed history file so `rollback` picks the wrong entry; a changed
verify-probe contract without the matching change in
`verify-deploy.js`. The blast radius is prod itself — every miss here
is immediately user-visible.

## Must-check behaviors

- Deploy/rollback keep the append-only `.deploy-history` contract:
  format and append semantics unchanged, or both sides updated together.
- Env/secret handling never logs token values.
- The `verify-deploy.js` JSON-verdict stdout contract is unchanged, or
  every consumer of that verdict is updated in the same diff.
- Dockerfile/compose changes keep the build-from-master assumption the
  isolation model relies on (`docs/factory.md`, "Isolation").

## Paths to skip

Prose style in `docs/deploy-host.md`; comment and whitespace nits in
the host-side `.sh` scripts.

## Evidence format

Every finding cites `file:line`, names the contract broken (history
format, verify-verdict stdout, env/secret handling, build-from-master),
and cites the command that demonstrates it — e.g. `node scripts/deploy.js …`
or `node scripts/verify-deploy.js …`, or the actual gate the change
breaks — rather than a bare claim.

## Nit cap

At most 2 style nits per `[REVIEW:CHANGES]` verdict comment for this
area — high-stakes surface, findings should be substantive.
