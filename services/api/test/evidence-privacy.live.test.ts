import { inflateSync } from "node:zlib";
import { containsPii } from "@keelson/evidence";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";

// Reads every public item of every bundle stored in the deployed database (DATABASE_URL on
// Render) and looks for PII: an email address or phone number anywhere, the sandbox buyer's own
// values in the raw bytes and in the text chunks of the screenshots, and in the HAR any cookie,
// authorization header or form body.
const live = process.env.KEELSON_LIVE === "1" && process.env.KEELSON_PRIVACY_SCAN === "1";

/** The values of PAYPAL_SANDBOX_* fields, and each comma-separated part of the address. */
function knownValues(): string[] {
  const values = [
    process.env.PAYPAL_SANDBOX_BUYER_EMAIL,
    process.env.PAYPAL_SANDBOX_BUYER_NAME,
    process.env.PAYPAL_SANDBOX_PERSONAL_EMAIL,
    ...(process.env.PAYPAL_SANDBOX_BUYER_ADDRESS ?? "").split(","),
  ];
  return values.map((v) => v?.trim().toLowerCase() ?? "").filter((v) => v.length >= 4);
}

/** The text of a PNG's tEXt, zTXt and iTXt chunks. */
function pngText(png: Uint8Array): string {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: string[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const len = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "tEXt" || type === "iTXt") out.push(new TextDecoder().decode(data));
    if (type === "zTXt") {
      const nul = data.indexOf(0);
      out.push(new TextDecoder().decode(inflateSync(data.subarray(nul + 2))));
    }
    at += 12 + len;
  }
  return out.join("\n");
}

const FORBIDDEN_HEADERS = new Set(["cookie", "set-cookie", "authorization"]);

interface Har {
  log: {
    entries: {
      request: { headers?: { name: string }[]; postData?: { mimeType?: string } };
      response: { headers?: { name: string }[] };
    }[];
  };
}

function harFindings(bytes: Uint8Array): string[] {
  const har = JSON.parse(new TextDecoder().decode(bytes)) as Har;
  const out: string[] = [];
  for (const [i, e] of har.log.entries.entries()) {
    for (const h of [...(e.request.headers ?? []), ...(e.response.headers ?? [])])
      if (FORBIDDEN_HEADERS.has(h.name.toLowerCase())) out.push(`entry ${i}: ${h.name} header`);
    const form = e.request.postData?.mimeType ?? "";
    if (/x-www-form-urlencoded|multipart\/form-data/i.test(form)) out.push(`entry ${i}: form body`);
  }
  return out;
}

describe.skipIf(!live)("public evidence in the deployed database", { timeout: 120_000 }, () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(() => pool.end());

  test("no public item holds PII, a cookie, an authorization header or a form body", async () => {
    const values = knownValues();
    expect(values.length).toBeGreaterThan(0);
    const { rows } = await pool.query<{
      root: Buffer;
      index: number;
      type: string;
      media_type: string;
      bytes: Buffer;
    }>(
      `select root, index, type, media_type, bytes from evidence_items
       where type not like '%.original' order by root, index`,
    );
    const findings: string[] = [];
    const bundles = new Set<string>();
    for (const r of rows) {
      const where = `${r.root.toString("hex").slice(0, 12)}/${r.index} ${r.type}`;
      bundles.add(r.root.toString("hex"));
      const bytes = new Uint8Array(r.bytes);
      if (containsPii(r.media_type, bytes)) findings.push(`${where}: email or phone`);
      const text = (
        r.media_type === "image/png" ? pngText(bytes) : new TextDecoder().decode(bytes)
      ).toLowerCase();
      for (const v of values) if (text.includes(v)) findings.push(`${where}: a known value`);
      if (r.type === "har") for (const f of harFindings(bytes)) findings.push(`${where}: ${f}`);
    }
    console.info(`scanned ${rows.length} public items of ${bundles.size} bundles`);
    expect(findings).toEqual([]);
  });
});
