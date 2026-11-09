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

## PayPal webhooks

PayPal delivers the app's events to `POST /webhooks/paypal` (`https://api.keelson.finance/webhooks/paypal`)
for `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`,
`PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED` and `CUSTOMER.DISPUTE.CREATED|UPDATED|RESOLVED`.

- **Verification.** Each delivery is self-verified as PayPal documents it: `SHA256withRSA` over
  `transmission_id|transmission_time|webhook_id|crc32(body)`, with the CRC-32 of the exact bytes and
  `PAYPAL_WEBHOOK_ID` from configuration, never from the request. The certificate is fetched only
  from `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-…` (`api.paypal.com` in
  production), must chain to a pinned DigiCert root and name PayPal's message verification host,
  and is cached in memory and Key Value until it expires. Deliveries more than five minutes from
  their transmission time are refused. Simulator events are signed for the webhook id `WEBHOOK_ID`
  and are refused.
- **Store, then acknowledge.** A verified delivery is stored once per event id and transmission in
  `paypal_events`, with its bytes and headers, and answered `200` without calling PayPal. Refusals
  answer `400 invalid-signature` with a `code`; PayPal retries non-2xx answers for three days.
- **Re-read.** A worker leases stored events and re-reads each resource with the app's token:
  authorizations through the mandate's hold reconciliation, captures and refunds through the
  capture reconciliation, disputes by `GET /v1/customer/disputes/{id}`. Only what PayPal answers
  changes state; the body only names the resource. Network failures and 5xx answers retry with
  backoff (2 s · 4ⁿ, at most ten minutes) for a day.
- **Polling.** Every 30 s one instance lists the app's events since its cursor (with five minutes of
  overlap) and stores those not yet stored, and re-reads every dispute updated since its cursor.
  PayPal lists only events raised while a webhook is subscribed.

To register the webhook, or reset its event types, run
`node --env-file=../../.env scripts/paypal-webhook.ts` and set the printed id as
`PAYPAL_WEBHOOK_ID` (required in production). To rotate it, delete the webhook in PayPal, run the
script again and update `PAYPAL_WEBHOOK_ID`; deliveries signed for the old id are refused until
then and the poller covers the gap. `scripts/paypal-fixtures.ts` writes stored deliveries as test
fixtures.

## Dispute evaluation

A dispute stored over a Keelson purchase is handed to the Render workflow task
`keelson-workflows/evaluateDispute` (`src/workflows.ts`), started with the dispute id, status and
lifecycle stage as its idempotency key, so the webhook, the poller and every re-read start one run
a day at most per status and stage, and an escalated inquiry runs again. The API
starts it when `RENDER_API_KEY` and `DISPUTE_WORKFLOW` are set; otherwise the dispute stays `OPEN`.
A run:

1. re-reads the dispute with `GET /v1/customer/disputes/{id}`; the purchase is the one whose
   capture's `invoice_id` the dispute names as `invoice_number`;
2. makes sure an on-chain anchor covers the purchase's leaf, asking the log to anchor now when the
   latest anchor does not, and verifies the Alibi against the chain;
3. reads the capture and its order, and judges every mandate field of the countersigned evaluation
   on its own: it failed if the evaluation failed it or if the Alibi's Channel3 observation
   contradicts it;
4. sends the facts and the settlement terms to both TEE legs (`POST /v1/verdict`), which attribute
   the dispute with the attribution policy sets and sign the `Verdict`; both must sign the same
   digest with their admitted signers;
5. stores the verdict with its facts and signatures and moves the dispute and the purchase to
   `ATTRIBUTED`;
6. answers PayPal for the party at fault (`src/disputes/respond.ts`), once per action and stage.

| Party at fault    | Rules                   | PayPal call                                             | Evidence                                                                                                                                             |
| ----------------- | ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| User              | R10, R20, R32, R62, R70 | `provide-evidence` (or `send-message` while an inquiry) | `PERMISSION_DESCRIPTION` with the Alibi PDF; R10 `ONLINE_TRACKING_INFORMATION` with the Alibi PDF; R20 `PROOF_OF_REFUND` with the order's refund ids |
| Merchant          | R11, R21, R35, R40, R50 | same                                                    | `ORDER_DETAILS` with the Alibi PDF                                                                                                                   |
| Operator, Keelson | R00, R30, R31, R60, R61 | `accept-claim` (refund to the buyer)                    | none                                                                                                                                                 |

The rule fixes the call and the evidence type; each submission carries one evidence, because
PayPal requires an `item_id` on each of several evidences. With `ANTHROPIC_API_KEY` set, the notes are drafted
in two calls, because Citations cannot be combined with structured outputs: `claude-opus-5-5`
writes a statement citing the Alibi PDF and the verdict, then `claude-haiku-5-5` fits it into one
note per evidence type (2,000 characters each, PayPal's limit). A refusal, a failure or a statement
without citations sends the rule's fixed statement instead, so a model never delays or changes the
response. `pnpm test:live` runs the drafter against the API; `test/dispute-respond.sandbox.test.ts`
answers a buyer-opened sandbox dispute (`PAYPAL_RESPOND_DISPUTE_ID`) and has the sandbox adjudicate
it.

A failed read or signature fails the run, which Render retries five times with backoff. Nothing
defaults to a fact. `GET /v1/disputes/{id}` shows the party at fault, the verdict, the time from
the dispute's first webhook or poll to its verdict, and what was sent to PayPal (the statement's
text is not public: it quotes the Alibi).

## Hold lifecycle

A mandate that allows a single merchant holds its whole budget in one PayPal authorization:

```
SIGNED → HOLD_PENDING → ACTIVE → EXHAUSTED | EXPIRED | REVOKED
```

| Step                                                 | PayPal calls                                                              | `PayPal-Request-Id`                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| `POST /v1/mandates/{id}/hold`                        | Create Order, `intent: AUTHORIZE`, for `max_minor`                        | `hex(M)[:36]`                                 |
| buyer approval (JS SDK v6, one-time payment session) | none from the API                                                         | —                                             |
| `POST /v1/mandates/{id}/hold/authorize`              | Authorize Order, then Show Authorized Payment                             | `operationRequestId(orderId, "authorize")`    |
| reauthorization (maintenance)                        | Show Order, Show Authorized Payment, Reauthorize, Show Authorized Payment | `operationRequestId(parentId, "reauthorize")` |
| `POST /v1/mandates/{id}/revoke`, expiry              | Void Authorized Payment of the parent                                     | `operationRequestId(parentId, "void")`        |

`M` is the mandate hash the user's passkey signed and
`operationRequestId(id, op) = hex(SHA-256("<op>:<id>"))[:36]`, so a retry of any step is the same
PayPal request. The order carries `custom_id = ks1.<env>m.<mid>.<b64url(M)>` (77 characters;
`env` is `s` for the sandbox and `p` for production), `reference_id = mid` and the description
`Agent purchases under Keelson mandate <mid>`. `custom_id` ties the hold to the signed mandate:
anyone holding the mandate can check that the authorization is its own.

`POST /hold` refuses a mandate whose allowed merchant is not the account Keelson captures for
(`422 merchant-not-capturable`) and returns the same order while it can still be approved.
`POST /hold/authorize` authorizes only the order stored for the mandate and checks the
authorization against it (status `CREATED`, amount, currency, `custom_id` and payee); one that
does not match is voided (`422 hold-mismatch`). An authorization PayPal holds as `PENDING` leaves
the mandate in `HOLD_PENDING` until it is created.

An authorization is valid for 29 days and its funds are honored for the first 3
([Authorization and capture](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)).
Keelson reauthorizes each hold once, on the first maintenance run after day 3, for what is left
of the budget; PayPal answers with a new authorization id, which every later capture uses
([Reauthorize authorized payment](https://developer.paypal.com/docs/api/payments/v2/#authorizations_reauthorize)).
A refused reauthorization (`REAUTHORIZATION_*`) is recorded and not retried; the original
authorization stays capturable until it expires. A void always targets the original (parent)
authorization, because PayPal does not void a reauthorized payment (`CANNOT_BE_VOIDED`,
[Void authorized payment](https://developer.paypal.com/docs/api/payments/v2/#authorizations_void)).
A void answered with `AUTHORIZATION_VOIDED`, `AUTHORIZATION_EXPIRED`, `PREVIOUSLY_VOIDED` or
`PREVIOUSLY_CAPTURED` counts as done.

The hold ends when:

- the budget is spent: `EXHAUSTED` (the last capture is final, so PayPal closes the authorization);
- the user revokes it: new countersigns are refused at once, the parent is voided, `REVOKED`;
- the mandate's `exp` passes or the authorization reaches day 29 less one hour: void, `EXPIRED`.

No void runs while a purchase of the mandate may still be countersigned or captured; it waits for
it, at most 900 seconds (the countersign lifetime), and `POST /revoke` answers `202 REVOKING`
meanwhile. A maintenance loop started by the server runs every 10 minutes: it reconciles pending
holds with PayPal, reauthorizes, expires, exhausts, completes revocations and releases the holds
of ended per-purchase mandates. Every step is idempotent, so two instances overlapping during a
deploy are harmless.

A mandate that allows several merchants goes `SIGNED → ACTIVE` and holds each purchase
separately (below).

### Measured

`pnpm --filter @keelson/api bench:hold` (`SAMPLES`, default 20) signs, holds, authorizes and
revokes mandates one after another through the in-process API on the PayPal sandbox; the
buyer's approval is not timed. It needs Postgres, Valkey and the PayPal sandbox variables. Each
request includes the round trips to `api-m.sandbox.paypal.com` (authorize makes two, revoke one).

| Call                                        | Where measured                | Samples | p50      | p95      | p95 budget |
| ------------------------------------------- | ----------------------------- | ------- | -------- | -------- | ---------- |
| `POST /hold` (Create Order)                 | local workstation, 2026-11-08 | 20      | 1,421 ms | 1,705 ms | 1.2 s      |
| `POST /hold/authorize` (authorize + checks) | local workstation, 2026-11-08 | 20      | 3,167 ms | 3,455 ms | 1.5 s      |
| `POST /revoke` (void of the parent)         | local workstation, 2026-11-08 | 20      | 2,689 ms | 2,862 ms | 1.2 s      |

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

## Purchase pipeline

`POST /v1/countersign` accepts a cart only for an `ACTIVE` mandate that is not being revoked, and
only against the authorization captures use now (the mandate's hold, or this request's own
per-purchase hold). Every ALLOW then goes through one state machine, stored on its `purchases`
row:

```
COUNTERSIGNED ──► LOGGED ──► COVERED ──► CAPTURED
      └──────────────┴──────────┴──► FAILED  (nothing captured)
```

- **Log and coverage run in parallel.** The leaf (`@keelson/log` `leafFromCountersign`, with
  `paypal_ref_commit` over a per-purchase salt, the order and the authorization) is appended to
  the Alibi log; at the same time the operator signs the `Coverage` and the relayer sends
  `KeelsonBondVault.lockCoverage` under the key `KeelsonBondVault.lockCoverage:<coverage id>`.
  The coverage is fixed by the countersign (amount × 10,000 PYUSD units, a 100 bps premium,
  `expiresAt = issuedAt + disputeWindow`), so every attempt sends the same calldata. `LOGGED` is
  written when the log answers and `COVERED` once both have.
- **Capture runs last, and only from `COVERED`,** within 600 s of the countersign's `issuedAt`
  (below its 900 s lifetime), while the mandate is `ACTIVE`, not being revoked and has the amount
  left. It captures exactly the countersigned amount with
  `invoice_id = KS1-<purchase id>-<seq>-<base32(alibi digest)>` (the sequence number is taken once
  per mandate) and `PayPal-Request-Id = hex(countersign_digest)[:36]`; `final_capture` is set
  for a per-purchase hold and for the capture that spends the last of the budget, which ends the
  mandate `EXHAUSTED`.
- **Never twice.** A purchase driven before first looks for its capture on the order (by
  `invoice_id`) and adopts it; PayPal answers a repeated `PayPal-Request-Id` with the same
  capture; recording it (`CAPTURED`, budget reduced) is one conditional transaction, shared with
  `reconcileCapture`, which applies a capture re-read from PayPal by its `invoice_id`.
- **Durable without a queue.** A driver holds a 20 s lease on the row, renewed every 5 s; every
  5 s the server drives the purchases whose lease lapsed, from what their row says. Every step is
  idempotent, so a process killed at any point is resumed by another.
- **Failures.** Timeouts, 5xx, a pending transaction and an unavailable log are retried until the
  capture window closes; a log rejection, a vault revert, a PayPal refusal or a closed window ends
  the purchase `FAILED` with `failure_reason = '<step>:<code>'` (`log:`, `cover:`, `capture:`).
  A coverage locked for a purchase that then fails is released after its window. Since the log
  and the coverage run in parallel, a purchase whose log append keeps failing still locks its
  coverage; it is never captured, and the coverage is released after its window like any other.
- **Degraded mode.** With leg B down, leg A alone countersigns (leg B only ever judges what leg A
  read from PayPal, so the two legs run one after the other). A degraded purchase goes through the
  same log, coverage and capture, and its coverage has the vault's usual dispute window.

The countersign answers `200` with `state`, `logIndex`, `coverage` and `capture` (or `failure`),
or `202` with `Location: /v1/purchases/{id}` when a step is still pending after 4.5 s.
`GET /v1/purchases/{id}` returns the same view to the mandate's owner and to the client that
asked for the countersign. Each step is published on their `purchase:<id>` channels of
`GET /v1/events`: `purchase.countersigned`, `purchase.logged`, `purchase.covered`,
`purchase.captured`, `purchase.failed`, `purchase.denied`.

A DENY is logged too and stays `DENIED`. The ERC-8004 validation of a DENY is recorded with the
operator's signature over its `ValidationRequest`, and coverages are released
(`releaseCoverage`) once their window has passed. Keelson signs coverage only for the operator
whose key it holds (`KEELSON_OPERATOR_KEY` with `DEMO_AGENT_ID`); purchases of any other operator
end `FAILED` with `cover:operator-unavailable` before anything is sent.

### Latency of a purchase

Each step is a span when tracing is on (`OTEL_TRACES_EXPORTER=console`, or an OTLP endpoint):
`purchase.COUNTERSIGNED` (or `purchase.DENIED`), `purchase.LOGGED`, `purchase.COVERED` and
`purchase.CAPTURED`, with `purchase.id` and `countersign.mode`, and the outbound calls (undici)
and queries (pg) of each step nested under it. `bench/money-path.bench.ts` drives real sandbox
purchases (`PURCHASES`, `CONCURRENCY`, `HOLDS`, `DEGRADED_EVERY`) and prints the waterfall from
those spans as JSON.

On the warm path a purchase makes these round trips, in this order:

| Step        | Calls                                                                                                                                                                  | Runs                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Countersign | leg A (which reads the authorization from PayPal), then leg B with leg A's observation                                                                                 | in sequence: leg B judges what leg A read, since only leg A reads PayPal |
| Log         | one append to the log's private listener, which answers once the leaf is in a checkpoint                                                                               | in parallel with coverage                                                |
| Coverage    | `eth_estimateGas` (the simulation that refuses a reverting call), one KMS signature, one `eth_sendRawTransactionSync` to the sequencer, which answers with the receipt | in parallel with the log                                                 |
| Capture     | one `POST /v2/payments/authorizations/{id}/capture`                                                                                                                    | last                                                                     |

Nothing else goes out on the warm path. The nonce comes from Postgres, the base fee, balance and
vault parameters from short-lived caches, the PayPal token from its cache until expiry, and the
credential issuer and the log's witness policy (both needed for the Alibi) from per-process
caches. The first purchase after a deploy pays those reads once. RFC 3161 timestamps, the Alibi PDF and
anchoring are off the path, and `purchase.captured` is published before any of them.

## Runbook

`GET /status` lists every dependency of the money path with its health: Postgres, Redis, both
TEE legs, the log (each origin's checkpoint size and age), the relayer (balance, next nonce and
pending calls per chain, `degraded` below its balance floor), PayPal (`sandbox` or `production`,
`down` when an authenticated call fails), PayPal events (`lastWebhookAgeMs`, and
`lastPollAgeMs` of the 30 s poller, `down` past 2 minutes) and the anchor (the latest
checkpoint of the sandbox log anchored on Arbitrum Sepolia and its age). The operator's free bond
is on `GET /v1/operators/{agentId}`.

**Void a stuck hold.** `POST /v1/mandates/{id}/revoke` as the mandate's owner voids the
remainder of its authorization. A mandate past `exp` is voided by the hold maintenance loop on its
own. A hold PayPal voided outside Keelson arrives as `PAYMENT.AUTHORIZATION.VOIDED`, and the
mandate moves to `EXPIRED` once the re-read confirms it.

**A purchase stuck in a step.** A purchase in `COUNTERSIGNED`, `LOGGED` or `COVERED` whose lease
has lapsed is driven again within 5 s by any running instance. One that cannot finish fails on its
own when its 600 s capture window closes (`<step>:window-closed`), with nothing captured. Do not
edit `purchases.state` by hand: the capture step relies on it to never capture twice.

**Reconcile with PayPal.** Search Transaction Search (`GET /v1/reporting/transactions`) by
`invoice_id` (`KS1-<purchase id>-…`), then compare with `GET /v2/payments/authorizations/{id}`
of the mandate's hold. A capture PayPal holds and Postgres does not is adopted the next time the
purchase is driven, or when its `PAYMENT.CAPTURE.COMPLETED` is applied.

**Replay webhooks.** `GET /v1/notifications/webhooks-events` lists what PayPal sent;
`POST /v1/notifications/webhooks-events/{event_id}/resend` sends one again. A resent event is
stored once (`paypal_events` is keyed by event id) and applied from a fresh re-read. The poller
picks up anything missed within 30 s anyway.

**Anchor now.** `POST /alibi/2026-1/anchor` on the log's private listener, with its bearer
token, anchors the sandbox checkpoint at once (see the log's README). The API's anchor watcher
then re-issues every Alibi the new anchor covers with its `anchor` section.

**Rotate the PayPal client secret.** Generate a new secret for the app in the PayPal developer
dashboard. Set it as `PAYPAL_CLIENT_SECRET` on `keelson-api` and in the repository secrets that
the TEE deploy workflow passes to leg A, which reads PayPal with the same app. Redeploy both,
check that `GET /status` shows PayPal `up`, then revoke the old secret.

**Degraded mode.** When leg B does not answer, leg A alone countersigns: the purchase reads
`mode: "degraded"` in its view, its leaf and its Alibi, and still goes through the log, coverage
and capture. Two legs that sign different digests never capture.
