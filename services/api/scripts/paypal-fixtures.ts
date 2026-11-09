/**
 * Writes PayPal webhook deliveries the API verified and stored as test fixtures: the exact body
 * bytes, the `paypal-*` headers and the certificate their cert URL serves. Run by hand against
 * the database that received them:
 * `node scripts/paypal-fixtures.ts <database url> <webhook id> [event type ...]`.
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

const [url, webhookId, ...types] = process.argv.slice(2);
if (!url || !webhookId) throw new Error("usage: paypal-fixtures.ts <database url> <webhook id>");
const out = new URL("../../../packages/paypal/test/fixtures/webhooks/", import.meta.url);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query<{
    event_type: string;
    transmission_id: string;
    received_at: Date;
    headers: Record<string, string>;
    body: Buffer;
    cert_url: string;
  }>(
    `select distinct on (event_type, id) event_type, transmission_id, received_at, headers, body, cert_url
       from paypal_events
      where source = 'webhook' and ($1::text[] is null or event_type = any($1))
      order by event_type, id, received_at`,
    [types.length > 0 ? types : null],
  );
  const certs = new Map<string, string>();
  for (const row of rows) {
    let certPem = certs.get(row.cert_url);
    if (!certPem) {
      const res = await fetch(row.cert_url, { redirect: "error" });
      if (!res.ok) throw new Error(`${row.cert_url} answered ${res.status}`);
      certPem = await res.text();
      certs.set(row.cert_url, certPem);
    }
    const name = `${row.event_type.toLowerCase()}.${row.transmission_id.slice(0, 8)}.json`;
    const fixture = {
      capturedAt: row.received_at.toISOString(),
      webhookId,
      headers: row.headers,
      bodyBase64: row.body.toString("base64"),
      certPem,
    };
    writeFileSync(new URL(name, out), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(name);
  }
} finally {
  await client.end();
}
