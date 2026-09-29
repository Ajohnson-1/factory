import { describe, it, expect } from "vitest";
import type { EmbedBuilder } from "discord.js";
import {
  doneEmbed,
  failedEmbed,
  prReadyEmbed,
  progressEmbed,
  reviewPostedEmbed,
  startedEmbed,
} from "../../src/discord/embeds.js";

const PR_URL = "https://github.com/o/r/pull/7";

/** Discord rejects field values above this length, so builders must clamp. */
const FIELD_LIMIT = 1024;

function field(embed: EmbedBuilder, name: string) {
  return embed.data.fields?.find((f) => f.name === name);
}

describe("startedEmbed", () => {
  it("uses the started title", () => {
    expect(startedEmbed("Card one", "factory/c1").data.title).toBe(
      "🏭 Factory started"
    );
  });

  it("shows the card name in the Card field", () => {
    expect(field(startedEmbed("Card one", "factory/c1"), "Card")?.value).toBe(
      "Card one"
    );
  });

  it("shows the branch in backticks in the Branch field", () => {
    expect(
      field(startedEmbed("Card one", "factory/c1"), "Branch")?.value
    ).toBe("`factory/c1`");
  });
});

describe("progressEmbed", () => {
  it("uses the in-progress title", () => {
    expect(progressEmbed("Card one", "reading files").data.title).toBe(
      "⚙️ In progress"
    );
  });

  it("shows the activity detail in the Activity field", () => {
    expect(
      field(progressEmbed("Card one", "reading files"), "Activity")?.value
    ).toBe("reading files");
  });

  it("passes a detail at the field limit through unchanged", () => {
    const detail = "x".repeat(FIELD_LIMIT);

    expect(field(progressEmbed("Card one", detail), "Activity")?.value).toBe(
      detail
    );
  });

  it("truncates activity values longer than the Discord field limit", () => {
    const value = field(
      progressEmbed("Card one", "x".repeat(FIELD_LIMIT + 1)),
      "Activity"
    )?.value;

    expect(value).toHaveLength(FIELD_LIMIT);
    expect(value).toBe("x".repeat(FIELD_LIMIT));
  });
});

describe("prReadyEmbed", () => {
  it("uses the PR-ready title", () => {
    expect(prReadyEmbed("Card one", PR_URL).data.title).toBe(
      "✅ PR ready for review"
    );
  });

  it("shows the PR url in the PR field", () => {
    expect(field(prReadyEmbed("Card one", PR_URL), "PR")?.value).toBe(PR_URL);
  });
});

describe("failedEmbed", () => {
  it("uses the failure title", () => {
    expect(failedEmbed("Card one", "CI timed out").data.title).toBe(
      "❌ Factory run failed"
    );
  });

  it("shows the error message in the Error field", () => {
    expect(field(failedEmbed("Card one", "CI timed out"), "Error")?.value).toBe(
      "CI timed out"
    );
  });

  it("passes an error at the field limit through unchanged", () => {
    const error = "e".repeat(FIELD_LIMIT);

    expect(field(failedEmbed("Card one", error), "Error")?.value).toBe(error);
  });

  it("truncates error values longer than the Discord field limit", () => {
    const value = field(
      failedEmbed("Card one", "e".repeat(FIELD_LIMIT + 500)),
      "Error"
    )?.value;

    expect(value).toHaveLength(FIELD_LIMIT);
    expect(value).toBe("e".repeat(FIELD_LIMIT));
  });
});

describe("doneEmbed", () => {
  it("uses the done title", () => {
    expect(doneEmbed("Card one", PR_URL).data.title).toBe("🎉 Merged — card done");
  });

  it("shows the PR url in the PR field", () => {
    expect(field(doneEmbed("Card one", PR_URL), "PR")?.value).toBe(PR_URL);
  });
});

describe("reviewPostedEmbed", () => {
  const embed = () => reviewPostedEmbed("Card one", PR_URL, 3);

  it("uses the review title", () => {
    expect(embed().data.title).toBe("🔍 Review posted");
  });

  it("shows the card, the PR and how many findings landed", () => {
    expect(field(embed(), "Card")?.value).toBe("Card one");
    expect(field(embed(), "PR")?.value).toBe(PR_URL);
    expect(field(embed(), "Comments")?.value).toBe("3");
  });

  /**
   * A review that found nothing is a valid review (the charter says so), and this
   * is where that shows: `0` has to render rather than disappear, or a clean review
   * looks like the embed failed to build.
   */
  it("says zero rather than nothing when the review found no line to comment on", () => {
    expect(field(reviewPostedEmbed("Card one", PR_URL, 0), "Comments")?.value).toBe("0");
  });

  it("is an info-coloured notice, not a success or a failure", () => {
    // Review findings are not a completed card: green would read as "approved",
    // which is a decision the factory explicitly does not make.
    expect(embed().data.color).toBe(0x5865f2);
  });
});
