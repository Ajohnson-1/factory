import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";
import { store as defaultStore, type Store } from "../state/store.js";
import { trello } from "./client.js";

export interface TrelloWebhookEvent {
  model: string;
  action: string;
  card?: { id: string; name: string; idList: string };
  list?: { id: string; name: string };
}

export interface TrelloWebhookDeps {
  store?: Store;
}

/**
 * Handle a Trello webhook POST. We react to card moves into the Ready list.
 * Returns true if the event was handled.
 */
export async function handleTrelloWebhook(
  body: TrelloWebhookEvent,
  deps: TrelloWebhookDeps = {}
): Promise<boolean> {
  const store = deps.store ?? defaultStore;
  if (body.model !== "card" || body.action !== "updateCard" || !body.card) {
    return false;
  }
  // Trello sends the *new* list in `list` for move events
  if (body.list?.id !== config.trello.readyListId()) return false;

  const { id, name } = body.card;
  console.log(`[webhook] card "${name}" (${id}) moved to Ready`);
  store.enqueue(id, name);
  return true;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function checkSecret(req: IncomingMessage): boolean {
  const secret = config.factory.webhookSecret;
  if (!secret) return true;
  return req.headers["x-webhook-secret"] === secret;
}

export function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
