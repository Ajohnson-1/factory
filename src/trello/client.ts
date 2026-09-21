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

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  url: string;
}

export const trello = {
  async getCard(cardId: string): Promise<TrelloCard> {
    return api<TrelloCard>(`/cards/${cardId}`);
  },
  async moveCard(cardId: string, listId: string): Promise<void> {
    await api(`/cards/${cardId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idList: listId }),
    });
  },
  async addComment(cardId: string, text: string): Promise<void> {
    await api(`/cards/${cardId}/actionsComment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  },
  async createWebhook(cardId: string, callbackUrl: string): Promise<void>
  {
    await api(`/cards/${cardId}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: callbackUrl }),
    });
  },
};
