// Minimal Trello REST client for the software factory. See docs/factory.md.
// Reads TRELLO_KEY / TRELLO_TOKEN from process env, falling back to the repo's .env.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseDotEnv() {
  let txt = '';
  try {
    txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const fileEnv = parseDotEnv();
const creds = {
  key: process.env.TRELLO_KEY || fileEnv.TRELLO_KEY,
  token: process.env.TRELLO_TOKEN || fileEnv.TRELLO_TOKEN,
};

export const BOARD = process.env.TRELLO_BOARD || fileEnv.TRELLO_BOARD || 'ZHkVYBN1';
export const CARD_ID_RE = /[0-9a-f]{24}/i;
// Card references come in two forms: the internal 24-char hex id (accepted
// case-insensitively) and the 8-char alphanumeric SHORT LINK that Trello
// URLs carry — `https://trello.com/c/<token>/91-slug`. The REST API resolves
// a short link on /cards/{id}, but short links are CASE-SENSITIVE: never
// lowercase one. The URL branch runs first because a card URL's
// `#comment-<24hex>` fragment holds the comment's id, which the bare-id
// regex would otherwise extract (the exact misparse this ordering prevents).
const CARD_SHORT_URL_RE = /trello\.com\/c\/([0-9a-zA-Z]{8})(?:[/?#]|$)/;
const CARD_SHORT_RE = /^[0-9a-zA-Z]{8}$/;

// Pure classifier for CLI card args: a trello.com/c/… URL, a bare 8-char
// short link, or a 24-char internal id (matched anywhere, so legacy URLs
// embedding the id still resolve). Returns { kind: 'id' | 'short', value }
// — ids lowercased, short links case-preserved — or null when unparseable.
export function parseCardRef(s) {
  const str = String(s ?? '').trim();
  const url = str.match(CARD_SHORT_URL_RE);
  if (url) return { kind: 'short', value: url[1] };
  const id = str.match(CARD_ID_RE);
  if (id) return { kind: 'id', value: id[0].toLowerCase() };
  if (CARD_SHORT_RE.test(str)) return { kind: 'short', value: str };
  return null;
}

const BASE = 'https://api.trello.com/1';

export function assertCreds() {
  if (!creds.key || !creds.token) {
    throw new Error(
      'Missing TRELLO_KEY/TRELLO_TOKEN (process env or repo .env). Generate them at https://trello.com/account',
    );
  }
}

async function request(method, path, params = {}) {
  assertCreds();
  const url = new URL(BASE + path);
  const payload = { key: creds.key, token: creds.token, ...params };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    ...(method === 'GET'
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Trello ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Trello ${method} ${path} -> non-JSON response: ${text.slice(0, 200)}`);
  }
}

// FM-2 (§4.2): every exported call takes a trailing `{ board = BOARD }`
// option; the `BOARD` default keeps today's precedence (env → .env →
// ZHkVYBN1) so all existing single-board usage is byte-identical.
// Board-scoped calls (getBoard/getLists/getBoardCards/getLabels) address
// `opts.board`; card-scoped calls accept the option for interface uniformity
// (the Trello card endpoints are card-id keyed — the board is ignored, so a
// caller threading a board never needs to special-case which call it passes).
const B = (opts) => opts?.board ?? BOARD;

export const getBoard = (opts = {}) => request('GET', `/boards/${B(opts)}`, { fields: 'id,name' });
export const getLists = (opts = {}) =>
  request('GET', `/boards/${B(opts)}/lists`, { fields: 'id,name,pos,closed' });
export const getBoardCards = (fields = 'id,name,idList,labels,due,url', opts = {}) =>
  request('GET', `/boards/${B(opts)}/cards`, { fields, limit: 250 });
export const getCard = (id, fields = 'id,name,desc,url,idList,labels', opts = {}) =>
  request('GET', `/cards/${id}`, { fields });
// Resolve any accepted card reference (parseCardRef) to the internal 24-char
// id — everything downstream keys on it: the factory/<id> branch + worktree,
// daemon state JSON, [PROD-WATCH] eval seeds. An id passes through with zero
// API calls; a short link costs one GET (card-scoped calls ignore `board`,
// so none is threaded here). `fetchCard` is injectable for tests.
export async function resolveCardId(s, fetchCard = getCard) {
  const ref = parseCardRef(s);
  if (!ref) return null;
  if (ref.kind === 'id') return ref.value;
  const card = await fetchCard(ref.value, 'id');
  return card && card.id ? String(card.id).toLowerCase() : null;
}
// Bot identity for the ask protocol's author matching (factory-ask.js): { id, username, fullName, ... }
// NOTE: the path is /members/me — /members/me/all 404s on the live API (the
// `all` association suffix is not accepted for `me`), which had silently
// degraded the ask protocol to tag-only mode.
export const getMe = (opts = {}) => request('GET', '/members/me', { fields: 'id,username,fullName' });
export const getCardComments = (id, limit = 50, opts = {}) =>
  request('GET', `/cards/${id}/actions`, { filter: 'commentCard', limit, memberCreator: true });
// List moves (`updateCard:idList`) with authorship: scheduler moves are made
// with the token member (`ompbot`), UI drags by the dragging member, so
// `memberCreator` tells a human drag from a scheduler move (the comment-resume
// watcher's human-move trigger, scripts/lib/factory-comment-resume.js).
export const getCardMoves = (id, limit = 25, opts = {}) =>
  request('GET', `/cards/${id}/actions`, { filter: 'updateCard:idList', limit, memberCreator: true });
export const getLabels = (opts = {}) => request('GET', `/boards/${B(opts)}/labels`, { fields: 'id,name,color' });
export const createList = (name, idBoard, opts = {}) => request('POST', '/lists', { name, idBoard });
export const createLabel = (name, color, idBoard, opts = {}) =>
  request('POST', '/labels', { name, color, idBoard });
export const addLabelToCard = (cardId, labelId, opts = {}) =>
  request('POST', `/cards/${cardId}/idLabels`, { value: labelId });
export const removeLabelFromCard = (cardId, labelId, opts = {}) =>
  request('DELETE', `/cards/${cardId}/idLabels/${labelId}`);
export const createCard = (name, idList, desc = '', opts = {}) =>
  request('POST', '/cards', { name, idList, desc, pos: 'top' });
export const moveCard = (cardId, listId, opts = {}) => request('PUT', `/cards/${cardId}`, { idList: listId });
export const setCardClosed = (cardId, closed, opts = {}) => request('PUT', `/cards/${cardId}`, { closed });
export const setCardDesc = (cardId, desc, opts = {}) => request('PUT', `/cards/${cardId}`, { desc });
export const closeList = (listId, opts = {}) => request('PUT', `/lists/${listId}/closed`, { value: true });
export const setListPos = (listId, pos, opts = {}) => request('PUT', `/lists/${listId}`, { pos });
export const addComment = (cardId, text, opts = {}) =>
  request('POST', `/cards/${cardId}/actions/comments`, { text });
