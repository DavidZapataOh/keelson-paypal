import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import {
  citedText,
  type DraftInput,
  failureOf,
  fieldsOf,
  NOTE_MAX,
  templateNotes,
  withSources,
} from "../src/disputes/drafter.ts";
import { responsePlan } from "../src/disputes/evidence.ts";

const plan = responsePlan({ ruleId: 70, liable: 4 });
if (plan.action !== "contest") throw new Error("unreachable");

const input: DraftInput = {
  plan,
  step: "provide_evidence",
  dispute: { id: "PP-R-OII-10196673", reason: "UNAUTHORISED", amount: "30.00 USD" },
  verdict: { rule: "R70", digest: `0x${"ab".repeat(32)}`, facts: { reason: "UNAUTHORISED" } },
  alibiPdf: new Uint8Array(),
};

const reply = (over: Partial<Anthropic.Beta.BetaMessage>) =>
  ({ stop_reason: "end_turn", content: [], ...over }) as Anthropic.Beta.BetaMessage;

describe("drafter", () => {
  test("a cited reply renders numbered sources after the last fallback", () => {
    const content = [
      { type: "text", text: "discarded", citations: null },
      { type: "fallback" },
      { type: "text", text: "The buyer signed a mandate", citations: null },
      {
        type: "text",
        text: " capped at 30.00 USD",
        citations: [
          {
            type: "page_location",
            cited_text: "Max amount 30.00 USD",
            document_index: 0,
            document_title: "Alibi",
            start_page_number: 1,
            end_page_number: 2,
            file_id: null,
          },
        ],
      },
      { type: "text", text: ".", citations: null },
    ] as unknown as Anthropic.Beta.BetaMessage["content"];
    const { text, citations } = citedText(content);
    expect(text).toBe("The buyer signed a mandate capped at 30.00 USD[1].");
    expect(citations).toEqual([{ text: "Max amount 30.00 USD", document: "Alibi", pages: [1, 2] }]);
    expect(withSources(text, citations)).toContain('[1] Alibi p.1: "Max amount 30.00 USD"');
  });

  test("refusals and cut-off replies are failures, read before the content", () => {
    expect(failureOf(reply({ stop_reason: "refusal" }))).toBe("refused");
    expect(failureOf(reply({ stop_reason: "max_tokens" }))).toBe("max_tokens");
    expect(failureOf(reply({ stop_reason: "tool_use" }))).toBe("invalid_output");
    expect(failureOf(reply({}))).toBeNull();
  });

  test("the fixed statement fills every planned field within PayPal's limit", () => {
    expect(fieldsOf(input)).toEqual(["PERMISSION_DESCRIPTION", "ORDER_DETAILS"]);
    expect(fieldsOf({ ...input, step: "send_message" })).toEqual(["message"]);
    const notes = templateNotes(input);
    expect(Object.keys(notes)).toEqual(["PERMISSION_DESCRIPTION", "ORDER_DETAILS"]);
    for (const note of Object.values(notes)) {
      expect(note).toContain("R70");
      expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    }
  });
});
