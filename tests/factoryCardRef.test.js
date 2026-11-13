/**
 * Unit tests for card-reference parsing/resolution (scripts/lib/trello.js
 * parseCardRef + resolveCardId, wired through scripts/factory.js
 * parseCardId). The failure that motivated this: a trello.com/c/<token> URL
 * — the form humans paste — was rejected outright, and a bare token would
 * have been lowercased (short links are case-sensitive). A card URL's
 * `#comment-<24hex>` fragment must NOT be mistaken for the card id.
 *
 * Zero live Trello: parseCardRef is pure; resolveCardId runs against an
 * injected fake fetch (the factoryContext.test.js injection precedent). The
 * CLI is spawned only on the path that dies BEFORE network (unparseable
 * arg) — the factoryProdClose.test.js precedent.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseCardRef, resolveCardId } from '../scripts/lib/trello.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY = path.join(ROOT, 'scripts', 'factory.js');

const ID = '6af623a7c8924f3e7df3c109'; // internal id shape (24 hex)
const TOKEN = 'BFdZiCPu'; // short link shape — mixed case, non-hex chars

// 1. Bare internal id passes through, case-folded to lowercase.
{
  const r = parseCardRef(ID);
  assert.deepEqual(r, { kind: 'id', value: ID });
  assert.deepEqual(parseCardRef(ID.toUpperCase()), { kind: 'id', value: ID });
}

// 2. Legacy URL form embedding the 24-hex id still extracts it.
{
  assert.deepEqual(parseCardRef(`https://x/?id=${ID}&t=1`), { kind: 'id', value: ID });
}

// 3. Bare short link is classified as a short ref, CASE PRESERVED (a
// lowercased token is a different link — regression guard for the old
// blanket .toLowerCase()).
{
  assert.deepEqual(parseCardRef(TOKEN), { kind: 'short', value: TOKEN });
  assert.notEqual(parseCardRef(TOKEN).value, parseCardRef(TOKEN).value.toLowerCase());
}

// 4. All-hex 8-char tokens stay shorts (they are too short to be ids).
{
  assert.deepEqual(parseCardRef('deadbeef'), { kind: 'short', value: 'deadbeef' });
}

// 5. trello.com/c/<token> URL → token, with and without the /<n>-slug path.
{
  assert.deepEqual(parseCardRef(`https://trello.com/c/${TOKEN}/91-slug-here`), {
    kind: 'short',
    value: TOKEN,
  });
  assert.deepEqual(parseCardRef(`https://trello.com/c/${TOKEN}`), {
    kind: 'short',
    value: TOKEN,
  });
}

// 6. Regression (card BFdZiCPu, comment anchor form
// trello.com/c/BFdZiCPu#comment-6af66d3297e8860597b1d0c7): the fragment's
// 24-hex is the COMMENT id — the short link must win, not the bare-id match.
{
  const commentId = '6af66d3297e8860597b1d0c7';
  assert.notEqual(commentId, ID);
  assert.deepEqual(parseCardRef(`https://trello.com/c/${TOKEN}#comment-${commentId}`), {
    kind: 'short',
    value: TOKEN,
  });
}

// 7. Unparseable args → null (fail-closed; the CLI dies on these).
{
  for (const bad of ['', '   ', null, undefined, 'not a card', 'abcdefg', 'abcdefghi',
    'trello.com/c/short', '6af6'])
    assert.equal(parseCardRef(bad), null, `expected null for ${JSON.stringify(bad)}`);
}

// 8. resolveCardId: an internal id is returned WITHOUT touching the API
// (zero calls — the hot path stays free).
{
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { id: ID };
  };
  const got = await resolveCardId(ID.toUpperCase(), fake);
  assert.equal(got, ID);
  assert.equal(calls, 0);
}

// 9. resolveCardId: a short link resolves to the internal id via ONE fetch
// carrying the case-preserved token.
{
  const calls = [];
  const fake = async (ref, fields) => {
    calls.push({ ref, fields });
    return { id: ID.toUpperCase() };
  };
  const got = await resolveCardId(TOKEN, fake);
  assert.equal(got, ID);
  assert.deepEqual(calls, [{ ref: TOKEN, fields: 'id' }]);
}

// 10. resolveCardId: the full pasted URL — comment fragment included —
// fetches the short link, never the comment id.
{
  const commentId = '6af66d3297e8860597b1d0c7';
  const calls = [];
  const fake = async (ref) => {
    calls.push(ref);
    return { id: ID };
  };
  const got = await resolveCardId(`https://trello.com/c/${TOKEN}#comment-${commentId}`, fake);
  assert.equal(got, ID);
  assert.deepEqual(calls, [TOKEN]);
}

// 11. resolveCardId: unparseable → null, zero fetches.
{
  let calls = 0;
  assert.equal(await resolveCardId('not a card', async () => { calls += 1; return {}; }), null);
  assert.equal(calls, 0);
}

// 12. CLI end-to-end on the pre-network die path: an unparseable arg exits
// 1 with the contract message before any Trello call (no creds needed).
{
  const res = spawnSync(process.execPath, [FACTORY, 'read', 'not a card'], {
    encoding: 'utf8',
    env: { ...process.env, TRELLO_KEY: '', TRELLO_TOKEN: '' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Not a Trello card id or URL: not a card/);
}
