import { getDocument } from "pdfjs-dist";
import { describe, expect, it } from "vitest";
import { purchaseFacts } from "../src/facts.ts";
import { evidencePack } from "../src/visa.ts";
import { renderEvidencePackPdf } from "../src/visa-pdf.ts";
import { ALLOWED, alibi, DENIED } from "./fixtures.ts";

const NOW = new Date("2026-11-11T18:00:00Z");
const pack = (id: string) => {
  const b = alibi(id);
  return evidencePack(b, purchaseFacts(b), {
    now: NOW,
    alibiUrl: `https://api.keelson.finance/v1/alibis/${id}`,
    shipping: undefined,
  });
};

describe("Agentic Evidence Pack", () => {
  it("maps the mandate's consent to §4.1.23.3, .6 and .9 with the pointers that prove it", () => {
    const p = pack(ALLOWED);
    const rule = (r: string) => p.requirements.find((x) => x.rule === r);
    expect(rule("4.1.23.3")).toMatchObject({ status: "evidenced" });
    expect(rule("4.1.23.3")?.evidence.map((e) => e.pointer)).toContain("/mandate/payload_sd/exp");
    expect(rule("4.1.23.4")).toMatchObject({ status: "evidenced" });
    expect(rule("4.1.23.6")).toMatchObject({ status: "evidenced" });
    expect(rule("4.1.23.9")).toMatchObject({ status: "not_evidenced" });
    expect(rule("4.1.23.2")).toMatchObject({ status: "not_evidenced" });
  });

  it("gives the CE3.0 elements in clear text to the mandate's user, flagging a short fingerprint", () => {
    const { elements } = pack(ALLOWED).ce3;
    expect(elements).toEqual([
      { element: "account_login_id", status: "provided", value: "andres@example.com" },
      {
        element: "device_fingerprint",
        status: "below_minimum",
        value: "fp_3c9a71",
        note: "CE3.0 requires at least 20 characters.",
      },
      { element: "ip_address", status: "provided", value: "203.0.113.7" },
      { element: "shipping_address", status: "not_available" },
      expect.objectContaining({ element: "prior_transactions", status: "merchant_to_supply" }),
    ]);
  });

  it("withholds the personal elements of a public Alibi", () => {
    const { elements } = pack(DENIED).ce3;
    expect(elements.slice(0, 3).map((e) => e.status)).toEqual(["withheld", "withheld", "withheld"]);
  });

  it("keeps the order confirmation at least 120 days from the countersign", () => {
    const p = pack(ALLOWED);
    expect(p.order_confirmation).toMatchObject({
      description: "1 × Trail running shoe",
      total_minor: 100,
      currency: "USD",
      return_policy: "30-day returns, free",
      retained_until: "2027-03-09T10:17:10.000Z",
    });
  });

  it("renders a PDF that embeds the pack", async () => {
    const p = pack(ALLOWED);
    const pdf = await renderEvidencePackPdf(p);
    const task = getDocument({ data: pdf.slice() });
    const doc = await task.promise;
    const [[id, file] = []] = [...((await doc.getAttachments()) ?? new Map()).entries()];
    expect(file?.filename).toBe(`${ALLOWED}.evidence.json`);
    expect(
      JSON.parse(new TextDecoder().decode((await doc.getAttachmentContent(id)) ?? undefined)),
    ).toEqual(p);
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => ("str" in i ? i.str : ""))
      .join(" ");
    expect(text).toContain("Agentic Evidence Pack");
    expect(text).toContain("4.1.23.3");
    await task.destroy();
  });
});
