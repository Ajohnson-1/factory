import { config } from "../config.js";

const BASE = "https://api.trello.com/1";

/**
 * `query` is for the parameters Trello's own spec declares as `in: query`.
 * Every Trello write operation — `POST /webhooks`, `POST /cards/{id}/actions/comments`,
 * `PUT /cards/{id}` — documents its inputs as query parameters and declares no
 * request body at all, while this client has always sent them as a JSON body.
 * Nothing here proves which form the live API insists on, so `createWebhook`
 * (the call the whole 2.4 trigger depends on) is sent both ways. A wrong guess
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
  /** PUT /1/cards/{id} — update a card, here: move it to another list. */
  async moveCard(cardId: string, listId: string): Promise<void> {
    await api(`/cards/${seg(cardId)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ idList: listId }),
    });
  },
  /** POST /1/cards/{id}/actions/comments */
  async addComment(cardId: string, text: string): Promise<void> {
    await api(`/cards/${seg(cardId)}/actions/comments`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text }),
    });
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
