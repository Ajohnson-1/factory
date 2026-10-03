import { describe, it, expect, beforeEach, vi } from "vitest";
import { trello } from "../../src/trello/client.js";

const BASE = "https://api.trello.com/1";

const fetchMock = vi.fn();

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** `[url, init]` of the single fetch call the module made. */
function called(n = 0): [string, RequestInit | undefined] {
  const call = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  expect(call).toBeDefined();
  return call;
}

function pathOf(n = 0): string {
  return new URL(called(n)[0]).pathname;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TRELLO_API_KEY", "apikey");
  vi.stubEnv("TRELLO_TOKEN", "usertoken");
});

describe("authentication", () => {
  it("appends the api key and token to every request", async () => {
    fetchMock.mockResolvedValue(reply({ id: "c1" }));
    await trello.getCard("c1");

    const params = new URL(called()[0]).searchParams;
    expect(params.get("key")).toBe("apikey");
    expect(params.get("token")).toBe("usertoken");
  });

  it("fails before the network when credentials are missing", async () => {
    vi.stubEnv("TRELLO_API_KEY", "");
    await expect(trello.getCard("c1")).rejects.toThrow(/TRELLO_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getCard", () => {
  it("GETs /cards/{id} and returns the parsed card", async () => {
    fetchMock.mockResolvedValue(
      reply({ id: "c1", name: "Card", desc: "", idList: "l1", url: "https://trello.com/c/c1" })
    );

    const card = await trello.getCard("c1");

    expect(pathOf()).toBe("/1/cards/c1");
    expect(called()[1]).toBeUndefined();
    expect(card).toMatchObject({ id: "c1", name: "Card" });
  });

  it("keeps a hostile card id inside its own path segment", async () => {
    fetchMock.mockResolvedValue(reply({ id: "x" }));
    await trello.getCard("../../webhooks");

    expect(pathOf()).toBe("/1/cards/..%2F..%2Fwebhooks");
  });
});

describe("error handling", () => {
  it("throws with the status and the response body", async () => {
    fetchMock.mockResolvedValue(reply("missing access key", 401));

    await expect(trello.getCard("c1")).rejects.toThrow(
      "Trello API 401: missing access key"
    );
  });

  it("survives an empty error body", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(trello.getCard("c1")).rejects.toThrow("Trello API 500: ");
  });
});

describe("moveCard", () => {
  it("PUTs the target list to /cards/{id}", async () => {
    fetchMock.mockResolvedValue(reply({ id: "c1" }));
    await trello.moveCard("c1", "list-review");

    const [url, init] = called();
    expect(new URL(url).pathname).toBe("/1/cards/c1");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ idList: "list-review" });
  });
});

describe("addComment", () => {
  it("POSTs the text to the card comments route", async () => {
    fetchMock.mockResolvedValue(reply({ id: "a1" }));
    await trello.addComment("c1", "Factory opened PR: https://x/y/1");

    const [url, init] = called();
    expect(new URL(url).pathname).toBe("/1/cards/c1/actions/comments");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Factory opened PR: https://x/y/1",
    });
  });
});

describe("createWebhook", () => {
  it("POSTs idModel + callbackURL to the top-level webhooks route", async () => {
    fetchMock.mockResolvedValue(
      reply({ id: "wh1", idModel: "board-1", callbackURL: "https://vps.example/webhook/trello", active: true })
    );
    const created = await trello.createWebhook("board-1", "https://vps.example/webhook/trello");

    const [url, init] = called();
    expect(new URL(url).pathname).toBe("/1/webhooks");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      callbackURL: "https://vps.example/webhook/trello",
      idModel: "board-1",
      description: "factory",
    });
    // The id comes back: it is the only handle on deleting the registration
    // again, and webhooks belong to the token that created them.
    expect(created).toMatchObject({ id: "wh1", idModel: "board-1" });
  });

  it("carries the documented query parameters as well as the body", async () => {
    // Trello's spec declares `callbackURL` / `idModel` / `description` as query
    // parameters and defines no request body for this operation. Which form the
    // live API honours has never been observed here, so both are sent.
    fetchMock.mockResolvedValue(reply({ id: "wh1" }));
    await trello.createWebhook("board-1", "https://vps.example/webhook/trello");

    const params = new URL(called()[0]).searchParams;
    expect(params.get("callbackURL")).toBe("https://vps.example/webhook/trello");
    expect(params.get("idModel")).toBe("board-1");
    expect(params.get("description")).toBe("factory");
    expect(params.get("key")).toBe("apikey");
    expect(params.get("token")).toBe("usertoken");
    expect(new URL(called()[0]).search.slice(1)).not.toContain("?");
  });

  it("takes a board id as idModel, not a card id", async () => {
    // The parameter used to be called `cardId`, which is what led README to tell
    // operators to add one webhook per card from a card menu that does not exist.
    fetchMock.mockResolvedValue(reply({ id: "wh2" }));
    await trello.createWebhook("board-1", "https://vps.example/webhook/trello", "board hook");

    expect(JSON.parse(String(called()[1]?.body))).toMatchObject({
      idModel: "board-1",
      description: "board hook",
    });
  });
});

describe("listWebhooks", () => {
  it("GETs the token's own webhooks, with the token in the path", async () => {
    fetchMock.mockResolvedValue(reply([{ id: "wh1", idModel: "board-1", callbackURL: "https://x/y" }]));

    const hooks = await trello.listWebhooks();

    const [url, init] = called();
    expect(new URL(url).pathname).toBe("/1/tokens/usertoken/webhooks");
    expect(init).toBeUndefined();
    expect(hooks).toEqual([{ id: "wh1", idModel: "board-1", callbackURL: "https://x/y" }]);
  });

  it("keeps a hostile token inside its own path segment", async () => {
    // The token comes from the environment rather than from Trello, but it still
    // gets the same treatment every other id gets.
    vi.stubEnv("TRELLO_TOKEN", "../webhooks");
    fetchMock.mockResolvedValue(reply([]));
    await trello.listWebhooks();

    expect(new URL(called()[0]).pathname).toBe("/1/tokens/..%2Fwebhooks/webhooks");
  });
});

describe("deleteWebhook", () => {
  it("DELETEs /webhooks/{id}", async () => {
    fetchMock.mockResolvedValue(reply({}));

    await trello.deleteWebhook("wh1");

    const [url, init] = called();
    expect(new URL(url).pathname).toBe("/1/webhooks/wh1");
    expect(init?.method).toBe("DELETE");
  });
});
