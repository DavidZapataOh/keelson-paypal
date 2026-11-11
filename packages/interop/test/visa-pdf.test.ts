import { mkdirSync, writeFileSync } from "node:fs";
import { encodeAlibi } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { base64url } from "jose";
import { getDocument } from "pdfjs-dist";
import { expect, test } from "vitest";
import { purchaseFacts } from "../src/facts.ts";
import { evidencePack } from "../src/visa.ts";
import { renderEvidencePackPdf } from "../src/visa-pdf.ts";
import { ALLOW_CARD, ALLOW_PAYPAL, alibi, NOW, refFor, testIssuer } from "./fixtures.ts";

const out = process.env.VISA_PDF_OUT;
if (out) mkdirSync(out, { recursive: true });

async function render(id: string) {
  const b = alibi(id);
  const pack = await evidencePack(
    purchaseFacts(b),
    refFor(id),
    { issuer: await testIssuer(id) },
    { now: NOW, bundle: b },
  );
  return { b, pack, pdf: await renderEvidencePackPdf(pack, encodeAlibi(b)) };
}

test.each([ALLOW_PAYPAL, ALLOW_CARD])(
  "%s renders the same PDF twice, with the pack, statement and Alibi attached",
  async (id) => {
    const { b, pack, pdf } = await render(id);
    const again = await renderEvidencePackPdf(pack, encodeAlibi(b));
    expect(Buffer.from(again).equals(Buffer.from(pdf))).toBe(true);
    if (out) writeFileSync(`${out}/${id}.visa-evidence.pdf`, pdf);

    const task = getDocument({ data: pdf.slice() });
    const doc = await task.promise;
    const attachments = (await doc.getAttachments()) as Map<string, { filename: string }>;
    const byName: Record<string, Uint8Array> = {};
    for (const [key, a] of attachments)
      byName[a.filename] = (await doc.getAttachmentContent(key)) as Uint8Array;
    await task.destroy();
    expect(Object.keys(byName).sort()).toEqual([
      `${id}.alibi`,
      `${id}.cose`,
      "keelson-evidence-pack.json",
    ]);
    expect(JSON.parse(new TextDecoder().decode(byName["keelson-evidence-pack.json"]))).toEqual(
      pack,
    );
    expect(base64url.encode(byName[`${id}.cose`] as Uint8Array)).toBe(pack.alibi.statement);
    const embedded = JSON.parse(new TextDecoder().decode(byName[`${id}.alibi`]));
    expect((await verifyAlibi(embedded, { chain: null, now: new Date(NOW * 1000) })).verdict).toBe(
      "verified-offline",
    );
  },
);
