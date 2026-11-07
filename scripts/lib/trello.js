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

export const getBoard = () => request('GET', `/boards/${BOARD}`, { fields: 'id,name' });
export const getLists = () =>
  request('GET', `/boards/${BOARD}/lists`, { fields: 'id,name,pos,closed' });
export const getBoardCards = (fields = 'id,name,idList,labels,due,url') =>
  request('GET', `/boards/${BOARD}/cards`, { fields, limit: 250 });
export const getCard = (id, fields = 'id,name,desc,url,idList,labels') =>
  request('GET', `/cards/${id}`, { fields });
// Bot identity for the ask protocol's author matching (factory-ask.js): { id, username, fullName, ... }
// NOTE: the path is /members/me — /members/me/all 404s on the live API (the
// `all` association suffix is not accepted for `me`), which had silently
// degraded the ask protocol to tag-only mode.
export const getMe = () => request('GET', '/members/me', { fields: 'id,username,fullName' });
export const getCardComments = (id, limit = 50) =>
  request('GET', `/cards/${id}/actions`, { filter: 'commentCard', limit, memberCreator: true });
// List moves (`updateCard:idList`) with authorship: scheduler moves are made
// with the token member (`ompbot`), UI drags by the dragging member, so
// `memberCreator` tells a human drag from a scheduler move (the comment-resume
// watcher's human-move trigger, scripts/lib/factory-comment-resume.js).
export const getCardMoves = (id, limit = 25) =>
  request('GET', `/cards/${id}/actions`, { filter: 'updateCard:idList', limit, memberCreator: true });
export const getLabels = () => request('GET', `/boards/${BOARD}/labels`, { fields: 'id,name,color' });
export const createList = (name, idBoard) => request('POST', '/lists', { name, idBoard });
export const createLabel = (name, color, idBoard) =>
  request('POST', '/labels', { name, color, idBoard });
export const addLabelToCard = (cardId, labelId) =>
  request('POST', `/cards/${cardId}/idLabels`, { value: labelId });
export const removeLabelFromCard = (cardId, labelId) =>
  request('DELETE', `/cards/${cardId}/idLabels/${labelId}`);
export const createCard = (name, idList, desc = '') =>
  request('POST', '/cards', { name, idList, desc, pos: 'top' });
export const moveCard = (cardId, listId) => request('PUT', `/cards/${cardId}`, { idList: listId });
export const setCardClosed = (cardId, closed) => request('PUT', `/cards/${cardId}`, { closed });
export const setCardDesc = (cardId, desc) => request('PUT', `/cards/${cardId}`, { desc });
export const closeList = (listId) => request('PUT', `/lists/${listId}/closed`, { value: true });
export const setListPos = (listId, pos) => request('PUT', `/lists/${listId}`, { pos });
export const addComment = (cardId, text) =>
  request('POST', `/cards/${cardId}/actions/comments`, { text });
