/**
 * Subscribes Keelson to the offer events of each catalog SKU in `channel3-skus.json`, on the
 * SKU's own merchant domain and variant, and writes the subscription ids back. Creating is
 * idempotent on Channel3's side; subscriptions cost no credits, a lookup for a missing product id
 * costs one. Run by hand: `node scripts/channel3-subscribe.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createChannel3 } from "../src/channel3/client.ts";

interface Sku {
  url: string;
  note: string;
  catalog: boolean;
  product_id?: string;
  selection?: { name: string; label: string }[];
  subscription_id?: string;
}

const apiKey = process.env.CHANNEL3_API_KEY;
if (!apiKey) throw new Error("CHANNEL3_API_KEY is not set");

const file = new URL("../channel3-skus.json", import.meta.url);
const skus = JSON.parse(readFileSync(file, "utf8")) as Sku[];
const { client, lookup } = createChannel3(apiKey);

for (const sku of skus) {
  if (!sku.catalog) {
    console.log(`skipped ${sku.url}: Channel3 tracks catalog products only`);
    continue;
  }
  if (!sku.product_id) {
    const res = await lookup(sku.url);
    const product = res.product as { id: string; variants?: { selected?: Sku["selection"] } };
    if (res.error) throw new Error(`lookup failed for ${sku.url}: ${res.error}`);
    sku.product_id = product.id;
    const selected = product.variants?.selected;
    if (!sku.selection && selected?.length) sku.selection = selected;
  }
  const domain = new URL(sku.url).hostname.replace(/^www\./, "");
  const subscription = await client.productSubscriptions.create({
    product_id: sku.product_id,
    events: ["offer.price.changed", "offer.availability.changed"],
    domains: [domain],
    ...(sku.selection?.length ? { selection: sku.selection } : {}),
  });
  sku.subscription_id = subscription.subscription_id;
  console.log(
    `${subscription.status} ${subscription.subscription_id} ${subscription.product_id} ${domain}`,
  );
}
writeFileSync(file, `${JSON.stringify(skus, null, 2)}\n`);

const listed = await client.productSubscriptions.list({ status: "active" });
const active = new Set(listed.data.map((s) => s.subscription_id));
for (const sku of skus.filter((s) => s.subscription_id)) {
  if (!active.has(sku.subscription_id as string))
    throw new Error(`${sku.url} is not listed as active`);
}
console.log(`${active.size} active subscriptions listed`);
