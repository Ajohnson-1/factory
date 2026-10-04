import { config } from "../config.js";

const BASE = "https://api.trello.com/1";

/**
 * `query` is for the parameters Trello's own spec declares as `in: query`.
 * Every Trello write operation — `POST /webhooks`, `POST /cards/{id}/actions/comments`,
 * `PUT /cards/{id}` — documents its inputs as query parameters and declares no
 * request body at all, while this client has always sent them as a JSON body.
 * Nothing here proves which form the live API insists on, so every write this
 * client makes — `createWebhook`, `moveCard`, `addComment` — is sent both ways. A wrong guess
 * on that one call does not fail loudly: Trello answers 200 to nothing, it
 * answers an error, and no webhook exists to deliver anything ever again.
 */
async function api<T>(
  path: string,
  init?: RequestInit,
  query?: Record<string, string>
): Promise<T> {
  const params = new URLSearchParams({
    key: config.trello.apiKey(),
    token: config.trello.token(),
    ...query,
  });
  const url = `${BASE}${path}?${params.toString()}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Card ids come from Trello/webhooks — keep them inside their path segment. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * How much of a write's value this client will duplicate into the URL.
 *
 * The both-forms rule needs a bound, because the two call sites are not
 * symmetric. `moveCard`'s `idList` is a 24-character Trello id and always fits.
 * `addComment`'s text does not: `src/worker/runner.ts:245` interpolates a raw
 * `Error.message`, with no truncation anywhere on that path, so the text is as
 * long as whatever the agent threw. A URL that outgrows the proxy in front of
 * `api.trello.com` is a hard 4xx, which would break a call that works today in
 * order to guard one that may never have been broken.
 *
 * So: mirror when it fits, send body-only when it does not. The loss is
 * confined to long failure comments — and that path is not silent, it also
 * writes `store.setFailed` and posts a Discord embed. The silent one
 * (`moveCard` to Review, where a 200 says nothing about whether the card moved)
 * always mirrors, because it always fits.
 */
const MAX_QUERY_MIRROR_CHARS = 2048;

function mirror(name: string, value: string): Record<string, string> {
  return value.length <= MAX_QUERY_MIRROR_CHARS ? { [name]: value } : {};
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  url: string;
}

/**
 * A webhook registration, as `POST /1/webhooks` returns it. The id matters:
 * it is the only handle on deleting the registration again, and webhooks belong
 * to the token that created them.
 */
export interface TrelloWebhook {
  id: string;
  description?: string;
  idModel: string;
  callbackURL: string;
  active?: boolean;
  consecutiveFailures?: number;
}

export const trello = {
  async getCard(cardId: string): Promise<TrelloCard> {
    return api<TrelloCard>(`/cards/${seg(cardId)}`);
  },
  /**
   * PUT /1/cards/{id} — update a card, here: move it to another list.
   *
   * `idList` goes as a query parameter as well as in the body, for the same
   * reason as `createWebhook`: the spec declares `PUT /cards/{id}` as query
   * parameters with no `requestBody`. If the body alone were the wrong form, the
   * symptom is not an error — this call returns 200 either way — it is a card
   * that silently never reaches Review, i.e. work finishes and the board says it
   * did not. Cheap insurance against an unobserved behaviour, and this value is
   * a 24-char id, so `mirror()` cannot drop it.
   */
  async moveCard(cardId: string, listId: string): Promise<void> {
    await api(
      `/cards/${seg(cardId)}`,
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ idList: listId }),
      },
      mirror("idList", listId)
    );
  },
  /**
   * POST /1/cards/{id}/actions/comments — same both-forms reasoning as
   * `moveCard`. A body-only failure here would mean the PR link never lands on
   * the card, which is invisible unless someone looks at the board.
   *
   * The query mirror is bounded (see `MAX_QUERY_MIRROR_CHARS`): the failure
   * comment carries an untruncated `Error.message`, and putting that in a URL is
   * how a working call starts returning 4xx.
   */
  async addComment(cardId: string, text: string): Promise<void> {
    await api(
      `/cards/${seg(cardId)}/actions/comments`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text }),
      },
      mirror("text", text)
    );
  },
  /**
   * POST /1/webhooks — webhooks are a top-level resource; the watched object
   * (card, list or board) is the `idModel` parameter.
   *
   * `idModel`, not `cardId`: the factory registers one webhook per BOARD, which
   * is what the docs' own action table supports — `updateCard` fires for a
   * webhook on the Card, the List, the Board and the Member. A per-card
   * registration would mean one new webhook for every card, forever, and the
   * board is the thing whose Ready list we care about.
   *
   * Trello HEADs `callbackURL` before accepting this, so the route must answer
   * 200 to a HEAD, and creates nothing if it does not.
   */
  async createWebhook(
    idModel: string,
    callbackUrl: string,
    description = "factory"
  ): Promise<TrelloWebhook> {
    return api<TrelloWebhook>(
      `/webhooks`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          callbackURL: callbackUrl,
          idModel,
          description,
        }),
      },
      // …and as the documented query parameters, same values.
      { callbackURL: callbackUrl, idModel, description }
    );
  },
  /**
   * GET /1/tokens/{token}/webhooks — every webhook created with this token.
   * There is no top-level list route, and the token is a PATH segment here, so
   * it goes through `seg()` like any other id. Used to make registration
   * idempotent: without it, every redeploy stacks another delivery onto the board.
   */
  async listWebhooks(): Promise<TrelloWebhook[]> {
    return api<TrelloWebhook[]>(`/tokens/${seg(config.trello.token())}/webhooks`);
  },
  /** DELETE /1/webhooks/{id} — drop a stale registration. */
  async deleteWebhook(webhookId: string): Promise<void> {
    await api(`/webhooks/${seg(webhookId)}`, { method: "DELETE" });
  },
};
