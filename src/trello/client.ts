import { config } from "../config.js";

const BASE = "https://api.trello.com/1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE}${path}?key=${config.trello.apiKey()}&token=${config.trello.token()}`;
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
   */
  async createWebhook(
    cardId: string,
    callbackUrl: string,
    description = "factory"
  ): Promise<void> {
    await api(`/webhooks`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        callbackURL: callbackUrl,
        idModel: cardId,
        description,
      }),
    });
  },
};
