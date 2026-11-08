# @keelson/api

The Hono API behind `api.keelson.finance`. Its routes are documented in the generated
[OpenAPI document](../../openapi/keelson.yaml).

## Channel3 observation

At decision time the agent's driver asks `POST /v1/observations/channel3` about the product page
it is on, in parallel with its evidence capture. The API sends Channel3 one
`POST /v1/lookup` with `max_staleness_hours: 1` and `realtime_fetch: true` (a live fetch when
Channel3's data is older than an hour), bounded at eight seconds and never retried, and never sends
a user identifier. It compares Channel3's answer with what the agent saw, field by field:

| Attribute    | Compared                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| variant      | each selected option by name, labels after NFKC, trimming and case-folding |
| price        | the offer on the page's domain: currency and integer minor units           |
| availability | `InStock` against what the agent saw                                       |
| brand        | the first brand, normalized like the labels                                |

The result is stored as a `keelson.channel3.observation/1` document with the time it was received
and the exact response bytes, and RFC 3161 tokens from two TSAs are queued over the SHA-256 of its
JCS bytes (`GET /v1/timestamps/{hash}`). A lookup that fails or times out is stored as
`unavailable`, so the absence of a second source is on record too. The response hands the agent a
sealed `channel3.observation` evidence item, which it adds after `har` before building its
manifest.

`POST /v1/countersign` finds that item in the evidence stored under `evidenceRoot` and uses it only
if the API issued it (same hash and salt), it belongs to the mandate, it is less than 900 seconds
old, it is the newest observation of that page for the mandate, it serves no other purchase, and
the view it compares was read from the evidence's own `api.product` item and describes a line of
the cart being countersigned (price, currency, and size and color where named). It then adds
`channel3:<match|mismatch|unknown>:<attribute>:<observation id>` sources to the `variant`, `total`
and `merchant` fields. An agent cannot write a `channel3:` source itself. Each client may make 100
observations a day.

Channel3 is third-party testimony, not proof. Its responses carry no signature of their own:
Keelson attests only when it received them, through the RFC 3161 tokens over their hash. The
engine shows the sources in the countersigned `keelson.eval/1` trace and they never change a
field's color or the decision. Nothing on the countersign path waits for Channel3.

### Offer events

For the demo SKUs in [`channel3-skus.json`](channel3-skus.json) Keelson holds Channel3 product
subscriptions to `offer.price.changed` and `offer.availability.changed`. Channel3 delivers them
through Svix to `POST /webhooks/channel3`; each delivery is verified with the endpoint's `whsec_`
secret over `svix-id.svix-timestamp.body` within five minutes, stored once per event `id` as the
exact bytes received, and stamped like an observation. The signature authenticates Channel3 to
Keelson only; it proves nothing to a third party. An observation lists the five newest events of
the last week for the same product and merchant.

To add a demo SKU, add its URL to `channel3-skus.json` (`catalog: true` when a lookup with
`realtime_fetch: false` finds it), then run, with `CHANNEL3_API_KEY` set:

```sh
node scripts/channel3-capture.ts <url>   # a dated fixture for the comparison tests, one credit
node scripts/channel3-subscribe.ts       # its subscription, free; one credit if the product id is new
```

### Configuration and budget

| Variable                  | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `CHANNEL3_API_KEY`        | Channel3 API key; required in production                                   |
| `CHANNEL3_WEBHOOK_SECRET` | The webhook endpoint's `whsec_` secret; the webhook answers 503 without it |

Channel3 gives 1,000 credits a month; each lookup costs one and subscriptions are free. The nightly
workflow spends one credit on a live lookup. `bench/channel3.bench.ts` measures lookup latency
(`LOOKUPS`, default 60 credits), the handler's own time and the stored sizes.

## Per-purchase holds

A mandate that allows more than one merchant is stored with `hold_mode = 'per_purchase'` and is
`ACTIVE` as soon as it is signed. Instead of one hold for the budget, the agent asks
`POST /v1/mandates/{id}/holds` for each cart, with the request id it will countersign under and
the mandate closed by its key over that request and cart (which proves it is the mandate's agent).
Keelson creates an `AUTHORIZE` order for exactly the cart total with
`custom_id = ks1.<env>a.<request_id>.<digest>` and `reference_id = request_id`; the user approves
it and `POST /v1/mandates/{id}/holds/{requestId}/authorize` authorizes it. The `PayPal-Request-Id`
of the order derives from the whole `custom_id`, so the same cart under two request ids is two
orders and a retry of one request is the same order.

`digest` is `SHA-256(dst || 0x00 || JCS(...))` (the Alibi domain) over `mandate_hash`, `cart_hash`,
`merchant_id`, the amount and the currency. It does not include the countersign digest and the order is not patched after
the countersign: leg A must read an authorized order to countersign, so the countersign cannot
exist when the order is created. The link to the countersign travels in the capture's
`invoice_id`, as it does for a mandate hold.

Leg A accepts a per-purchase hold whenever its request id is the countersign's, whatever the
mandate, so `POST /v1/countersign` refuses an authorization that is the hold of another mandate
or another request, and, for a per-purchase mandate, one that is not a hold Keelson created
(`422 authorization-not-held`).
