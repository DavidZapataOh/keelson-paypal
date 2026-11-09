import Anthropic from "@anthropic-ai/sdk";
import { renderAlibiPdf } from "@keelson/alibi/pdf";
import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { draftResponse, NOTE_MAX } from "../src/disputes/drafter.ts";
import { responsePlan } from "../src/disputes/evidence.ts";

const live = process.env.KEELSON_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;
const fixture = fixtures[0];

describe.skipIf(!live || !fixture)("dispute drafter (live)", () => {
  test("Opus cites the Alibi and Haiku fills every planned field", async () => {
    const bundle = fixture?.bundle as NonNullable<typeof fixture>["bundle"];
    const plan = responsePlan({ ruleId: 70, liable: 4 });
    if (plan.action !== "contest") throw new Error("unreachable");
    const pdf = await renderAlibiPdf(bundle);
    const draft = await draftResponse(new Anthropic(), {
      plan,
      step: "provide_evidence",
      dispute: { id: "PP-R-OII-10196673", reason: "UNAUTHORISED", amount: "30.00 USD" },
      verdict: {
        rule: "R70",
        digest: `0x${"ab".repeat(32)}`,
        facts: { reason: "UNAUTHORISED", proof_valid: true, failed_green: false },
      },
      alibiPdf: pdf,
    });
    console.info(
      JSON.stringify(
        {
          source: draft.source,
          failure: draft.failure,
          pdfBytes: pdf.byteLength,
          citations: draft.citations.length,
          notes: draft.notes,
          usage: draft.usage,
        },
        null,
        2,
      ),
    );
    expect(draft.source).toBe("model");
    expect(draft.citations.some((c) => c.document === "Alibi")).toBe(true);
    expect(Object.keys(draft.notes)).toEqual(["PERMISSION_DESCRIPTION"]);
    for (const note of Object.values(draft.notes)) {
      expect(note.length).toBeGreaterThan(0);
      expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    }
  }, 180_000);
});
