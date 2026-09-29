import { EmbedBuilder } from "discord.js";

const COLORS = {
  info: 0x5865f2,
  progress: 0x57f287,
  success: 0x57f287,
  failure: 0xed4245,
};

export function startedEmbed(cardName: string, branch: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle("🏭 Factory started")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "Branch", value: `\`${branch}\``, inline: true }
    );
}

export function progressEmbed(cardName: string, detail: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.progress)
    .setTitle("⚙️ In progress")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "Activity", value: detail.slice(0, 1024) }
    );
}

/**
 * How one agent on a card's timeline is named: `[coder-1]`, `[verifier]`.
 *
 * Run ids are minted as `c1`, `c2`… so the suffix is folded into the label;
 * anything else (the orchestrator's `orch`) reads better unqualified than
 * doubled into `orchestrator-orch`.
 */
export function agentLabel(role: string, runId: string): string {
  const seq = /^c(\d+)$/.exec(runId ?? "");
  return seq ? `${role}-${seq[1]}` : role;
}

export function agentStartedEmbed(cardName: string, role: string, runId: string, task: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🤖 ${agentLabel(role, runId)} started`)
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "Task", value: task.slice(0, 1024) }
    );
}

export function agentDoneEmbed(
  cardName: string,
  role: string,
  runId: string,
  status: string
): EmbedBuilder {
  const good = status === "ok";
  return new EmbedBuilder()
    .setColor(good ? COLORS.success : COLORS.failure)
    .setTitle(`${good ? "✅" : "❌"} ${agentLabel(role, runId)} ${status}`)
    .addFields({ name: "Card", value: cardName, inline: true });
}

export function prReadyEmbed(cardName: string, prUrl: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle("✅ PR ready for review")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "PR", value: prUrl }
    );
}

export function failedEmbed(cardName: string, error: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.failure)
    .setTitle("❌ Factory run failed")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "Error", value: error.slice(0, 1024) }
    );
}

export function doneEmbed(cardName: string, prUrl: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle("🎉 Merged — card done")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "PR", value: prUrl }
    );
}

/**
 * A review landed on a pull request (phase 2.3).
 *
 * The count is line comments only, not the summary: "1 review posted" next to a PR
 * with eight findings on it is the number an operator actually wants, and a review
 * that found nothing reads as a bare 0 rather than as a failure to report.
 */
export function reviewPostedEmbed(
  cardName: string,
  prUrl: string,
  commentCount: number
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle("🔍 Review posted")
    .addFields(
      { name: "Card", value: cardName, inline: true },
      { name: "Comments", value: String(commentCount), inline: true },
      { name: "PR", value: prUrl }
    );
}
