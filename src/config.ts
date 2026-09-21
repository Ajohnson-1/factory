import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  trello: {
    apiKey: () => req("TRELLO_API_KEY"),
    token: () => req("TRELLO_TOKEN"),
    boardId: () => req("TRELLO_BOARD_ID"),
    readyListId: () => req("READY_LIST_ID"),
    reviewListId: () => req("REVIEW_LIST_ID"),
    doneListId: () => req("DONE_LIST_ID"),
  },
  discord: {
    botToken: () => req("DISCORD_BOT_TOKEN"),
    channelId: () => req("DISCORD_CHANNEL_ID"),
  },
  github: {
    token: () => req("GITHUB_TOKEN"),
    owner: () => req("GITHUB_OWNER"),
    repo: () => req("GITHUB_REPO"),
    webhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
  factory: {
    repoPath: () => req("REPO_PATH"),
    webhookPort: Number(process.env.WEBHOOK_PORT ?? 8787),
    webhookSecret: process.env.WEBHOOK_SECRET ?? "",
    ciTimeoutMs: Number(process.env.CI_TIMEOUT_MS ?? 15 * 60_000),
  },
};
