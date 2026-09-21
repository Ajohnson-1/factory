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
