/**
 * Every problem type the API returns (RFC 9457 §3.1.1): its title and what it means for the
 * caller. `GET /problems/{slug}` serves each one as a page.
 */
export const PROBLEM_TYPES = {
  "agent-id-taken": {
    title: "Agent id taken",
    explain: "The agent id is already linked to an operator on another registry.",
    fix: "Link a different agent id, or unlink it from the other registry first.",
  },
  "alerts-unavailable": {
    title: "Alerts unavailable",
    explain: "This server has no alert channel configured.",
    fix: "Ask the operator of this deployment to configure alerts, then retry.",
  },
  "alibi-malformed": {
    title: "Malformed Alibi",
    explain: "The submitted Alibi could not be parsed or does not match its schema.",
    fix: "Send a well-formed Alibi in one of the supported media types.",
  },
  "alibi-not-found": {
    title: "Not found",
    explain: "No Alibi exists with the given id.",
    fix: "Check the id returned when the purchase was logged.",
  },
  "alibi-not-issued": {
    title: "Alibi not issued",
    explain: "The purchase has not been logged with its Alibi yet.",
    fix: "Retry after the purchase is logged.",
  },
  "amount-confirmation-expired": {
    title: "Confirmation expired",
    explain: "The user did not confirm the purchase's amount before the confirmation expired.",
    fix: "Do not pay. Ask for a new confirmation if the purchase should go ahead.",
  },
  "amount-declined": {
    title: "Amount declined",
    explain: "The user declined the amount PayPal's order charges for this purchase.",
    fix: "Do not pay this order.",
  },
  "amount-exceeds-mandate": {
    title: "Amount exceeds the mandate",
    explain: "The cart total is above the mandate's remaining budget or its per-purchase maximum.",
    fix: "Reduce the cart total, or ask the user to sign a mandate with a larger budget.",
  },
  "amount-mismatch": {
    title: "Amount mismatch",
    explain:
      "PayPal's order does not match what Keelson countersigned; the field member names what differs.",
    fix: "Do not pay. Re-quote the checkout and ask Keelson to countersign the new total.",
  },
  "amount-order-changed": {
    title: "Another order",
    explain: "Keelson decided this purchase's amount for a different PayPal order.",
    fix: "Check the amount of the order you are about to pay, then retry.",
  },
  answered: {
    title: "Already answered",
    explain: "This amount confirmation was already approved or declined.",
    fix: "Read the confirmation's state instead of answering it again.",
  },
  "approval-required": {
    title: "Paused for approval",
    explain:
      "The cart is above the amount the user chose to approve each time, so it waits for the user.",
    fix: "Wait for the user's answer, then continue with the approved cart.",
  },
  "authorization-not-held": {
    title: "Authorization not held",
    explain: "The PayPal authorization is not the hold of this mandate for this request.",
    fix: "Send the authorization id returned for this mandate's hold.",
  },
  "bad-filter": {
    title: "Bad filter",
    explain: "A query filter is malformed or names an unknown field.",
    fix: "Fix the filter syntax and retry.",
  },
  "budget-committed": {
    title: "Budget committed",
    explain: "Live and settled card purchases on this mandate already commit its whole budget.",
    fix: "Wait for open purchases to settle or close, or ask the user for a new mandate.",
  },
  "budget-spent": {
    title: "Budget spent",
    explain: "Today's query budget is used up. It resets at 00:00 UTC.",
    fix: "Retry after 00:00 UTC.",
  },
  "campaign-not-found": {
    title: "Not found",
    explain: "No red-team campaign exists with the given id.",
    fix: "Check the campaign id.",
  },
  "card-not-open": {
    title: "Card not open",
    explain:
      "The single-use card is not open. It opens once the purchase is logged and covered, and closes after one use or on expiry.",
    fix: "Log and cover the purchase first, or request a new card.",
  },
  "cards-unconfigured": {
    title: "Cards unconfigured",
    explain: "This server has no card issuing configured.",
    fix: "Use a PayPal checkout instead, or ask the deployment operator to configure cards.",
  },
  "chain-unavailable": {
    title: "Chain unavailable",
    explain: "The chain RPC did not answer, or this server does not read the requested chain.",
    fix: "Retry later, or use a chain this server supports.",
  },
  "change-pending": {
    title: "Change pending",
    explain: "A change to this mandate is already waiting for the user.",
    fix: "Poll the pending change instead of submitting another.",
  },
  "channel3-unconfigured": {
    title: "Channel3 unconfigured",
    explain: "No Channel3 API key is configured on this server.",
    fix: "Ask the deployment operator to configure Channel3.",
  },
  "channel3-webhook-unconfigured": {
    title: "Channel3 webhook unconfigured",
    explain: "No Channel3 webhook secret is configured, so deliveries cannot be verified.",
    fix: "Ask the deployment operator to configure the Channel3 webhook secret.",
  },
  "chargeback-open": {
    title: "Chargeback open",
    explain: "A chargeback is already open or being filed for this purchase.",
    fix: "Wait for the open chargeback to resolve.",
  },
  "client-ip-required": {
    title: "Client address unknown",
    explain:
      "The request's client address cannot be read, so it cannot be recorded in the mandate.",
    fix: "Send the request directly or through a proxy that forwards the client address.",
  },
  "clock-unverified": {
    title: "The legs' clocks could not be verified",
    explain: "The TEE legs' clocks could not be verified, so the request was not signed.",
    fix: "Retry shortly; this is usually temporary.",
  },
  "compile-conflict": {
    title: "Compilations conflict",
    explain: "The models compiled the request into conflicting mandates.",
    fix: "Rephrase the request more precisely and compile again.",
  },
  "compile-failed": {
    title: "Compile failed",
    explain: "The models could not compile the request into a mandate.",
    fix: "Rephrase the request and try again.",
  },
  "compile-needs-input": {
    title: "Input needed",
    explain: "The request is missing details needed to compile a mandate.",
    fix: "Answer the questions in the response and compile again.",
  },
  "compile-unavailable": {
    title: "Compiling unavailable",
    explain: "Compiling needs inputs that are not available yet.",
    fix: "Retry later; the response lists what is missing.",
  },
  "compile-unresolved": {
    title: "Request incomplete",
    explain: "The request is incomplete and could not be resolved into a mandate.",
    fix: "Add the missing details and compile again.",
  },
  "connection-closed": {
    title: "Request closed",
    explain: "The agent's request was already decided, expired or does not exist.",
    fix: "Start a new request from the agent.",
  },
  "countersign-mode": {
    title: "Countersign mode not accepted on chain",
    explain: "The chain does not accept this countersign mode.",
    fix: "Use a countersign mode the on-chain contract accepts.",
  },
  "credential-not-owned": {
    title: "Credential not owned",
    explain: "The mandate is not signed with one of your passkeys, or not the one it names.",
    fix: "Sign the mandate with your own registered passkey.",
  },
  "cross-origin": {
    title: "Forbidden",
    explain: "Judge Mode was started from outside the app.",
    fix: "Start Judge Mode from the app.",
  },
  "currency-mismatch": {
    title: "Currency mismatch",
    explain: "The currency differs from the mandate's currency.",
    fix: "Use the mandate's currency.",
  },
  "deadline-too-far": {
    title: "Deadline too far",
    explain: "A link's deadline can be at most 15 minutes ahead.",
    fix: "Set a deadline within 15 minutes.",
  },
  "decoys-unsupported": {
    title: "Decoys not supported yet",
    explain: "The TEEs do not resolve decoy digests yet.",
    fix: "Sign the mandate without decoys.",
  },
  "dependency-unavailable": {
    title: "Dependency unavailable",
    explain: "A service the API depends on did not answer. This is temporary.",
    fix: "Retry with backoff.",
  },
  "device-required": {
    title: "Device required",
    explain: "The request has no valid device id.",
    fix: "Send the app's device id in the Keelson-Device header.",
  },
  "embed-session-invalid": {
    title: "No embed session",
    explain: "There is no valid embed session for this request.",
    fix: "Open the embed again.",
  },
  "embed-token-invalid": {
    title: "Embed token invalid",
    explain: "The embed token was already used or has expired.",
    fix: "Ask the platform to show the approval again.",
  },
  "embed-user-unknown": {
    title: "Sign in first",
    explain: "The user has not signed in with a passkey on this embed.",
    fix: "Sign in with a passkey first.",
  },
  "evidence-cart-mismatch": {
    title: "Evidence cart mismatch",
    explain: "The cart stored with the evidence is not the cart being countersigned.",
    fix: "Upload evidence for the exact cart you are countersigning.",
  },
  "evidence-checkout-mismatch": {
    title: "Evidence checkout mismatch",
    explain: "The checkout amount stored with the evidence is not the purchase unit's amount.",
    fix: "Upload evidence whose checkout amount matches the PayPal purchase unit.",
  },
  "evidence-checkout-missing": {
    title: "Evidence checkout missing",
    explain:
      "A total with tax, shipping or a discount needs its PayPal amount stored with the evidence.",
    fix: "Add the checkout amount to the evidence and upload it again.",
  },
  "evidence-exists": {
    title: "Evidence exists",
    explain: "This evidence root is already stored for another mandate.",
    fix: "Build a new evidence bundle for this mandate.",
  },
  "evidence-fx-reference-unknown": {
    title: "Evidence reference rates unknown",
    explain: "The reference rates item in the evidence was not issued by Keelson.",
    fix: "Fetch current reference rates from Keelson and include them unchanged.",
  },
  "evidence-identity-unavailable": {
    title: "Evidence identity unavailable",
    explain: "The evidence encryption identity is not available right now. This is temporary.",
    fix: "Retry later.",
  },
  "evidence-limit": {
    title: "Evidence limit reached",
    explain: "This mandate already holds the maximum number of evidence bundles.",
    fix: "Reuse a stored bundle, or start a new mandate.",
  },
  "evidence-pii": {
    title: "Evidence holds PII",
    explain: "A public evidence item holds an email address or phone number.",
    fix: "Remove the personal data or seal that item, then upload again.",
  },
  "evidence-root-mismatch": {
    title: "Evidence root mismatch",
    explain: "The items do not build the manifest root that was sent.",
    fix: "Recompute the root from the exact items and upload again.",
  },
  "evidence-too-large": {
    title: "Evidence too large",
    explain: "The evidence exceeds the size limits.",
    fix: "Send fewer or smaller items.",
  },
  "evidence-undecryptable": {
    title: "Evidence does not open",
    explain: "A sealed item does not open with the evidence identity.",
    fix: "Seal the item to the current evidence recipient key and upload again.",
  },
  "evidence-unknown": {
    title: "Evidence unknown",
    explain: "The evidence root is not stored for this mandate.",
    fix: "Upload the evidence to /v1/evidence first.",
  },
  "evidence-used": {
    title: "Evidence used",
    explain: "The evidence root already binds another purchase.",
    fix: "Upload new evidence for this purchase.",
  },
  expired: {
    title: "Expired",
    explain: "The link's deadline has passed.",
    fix: "Request a new link.",
  },
  forbidden: {
    title: "Forbidden",
    explain: "You are authenticated but not allowed to perform this action.",
    fix: "Use an account or session with the required role.",
  },
  "forbidden-channel": {
    title: "Forbidden channel",
    explain: "You may not subscribe to this channel.",
    fix: "Subscribe only to channels your credentials cover.",
  },
  "fx-reference-unavailable": {
    title: "Reference rates unavailable",
    explain:
      "Keelson cannot get current reference exchange rates, which a converted charge needs. This is temporary.",
    fix: "Retry later, or pay in the buyer's currency.",
  },
  "gas-limit": {
    title: "Gas limit exceeded",
    explain: "The transaction would exceed the gas limit.",
    fix: "Simplify the call or retry later.",
  },
  "gas-price-cap": {
    title: "Gas price above the cap",
    explain: "The current gas price is above the relayer's cap.",
    fix: "Retry when gas prices fall.",
  },
  "grant-invalid": {
    title: "Link not accepted",
    explain: "The link grant was not accepted.",
    fix: "Open the Keelson window again.",
  },
  "hold-mismatch": {
    title: "Hold mismatch",
    explain: "The authorization does not match the hold or the mandate, so it was voided.",
    fix: "Authorize again with the exact held amount, currency and payee.",
  },
  "hold-not-pending": {
    title: "Hold not pending",
    explain:
      "The hold is not waiting for authorization, or the mandate ended while it was authorized.",
    fix: "Check the mandate and hold state before authorizing again.",
  },
  "holds-exceed-budget": {
    title: "Holds exceed the budget",
    explain:
      "With this hold, the mandate's pending and authorized holds exceed its remaining budget.",
    fix: "Wait for other holds to settle or void, or reduce the cart.",
  },
  "hosted-cap": {
    title: "Over the hosted operator's cap",
    explain: "The request is above the cap of Keelson's hosted operator.",
    fix: "Lower the amount, or register your own operator.",
  },
  "hosted-key-unavailable": {
    title: "Hosted operator unavailable",
    explain: "Keelson's hosted operator cannot countersign now. This is temporary.",
    fix: "Retry later.",
  },
  "http-error": {
    title: "Request failed",
    explain: "The request failed with an HTTP error.",
    fix: "Check the status code and detail, then retry if appropriate.",
  },
  "idempotency-in-progress": {
    title: "Request in progress",
    explain: "A request with this Idempotency-Key is still being processed.",
    fix: "Retry after a short delay with the same key.",
  },
  "idempotency-key-required": {
    title: "Idempotency-Key required",
    explain: "POST requests must carry an Idempotency-Key header of 1 to 255 characters.",
    fix: "Add a unique Idempotency-Key header.",
  },
  "idempotency-key-reused": {
    title: "Idempotency-Key reused",
    explain: "This Idempotency-Key was already used with a different request.",
    fix: "Use a new key for a different request.",
  },
  "insufficient-scope": {
    title: "Insufficient scope",
    explain: "The credentials lack the scope or session this action needs.",
    fix: "Request a token with the required scope, or sign in.",
  },
  internal: {
    title: "Internal server error",
    explain: "An unexpected server error occurred. It is usually temporary.",
    fix: "Retry later; if it persists, report the request id.",
  },
  "invalid-amount": {
    title: "Invalid amount",
    explain:
      "The amount is invalid for this operation, such as above what was settled or not the cart total.",
    fix: "Send an amount consistent with the cart and settlement.",
  },
  "invalid-cart": {
    title: "Invalid cart",
    explain: "The cart is invalid, for example a non-positive total or unsupported currency.",
    fix: "Fix the cart and retry.",
  },
  "invalid-channel": {
    title: "Invalid channel",
    explain: "The channel name is invalid.",
    fix: "Use 1 to 128 characters of A-Z, a-z, 0-9, colon, underscore or hyphen.",
  },
  "invalid-client-update": {
    title: "Invalid update",
    explain: "The OAuth client update is not allowed.",
    fix: "Change only fields this client permits.",
  },
  "invalid-closed-mandate": {
    title: "Invalid closed mandate",
    explain: "The closed mandate is missing or not closed with the agent's key.",
    fix: "Close the mandate with your agent's key and send it as closedMandate.",
  },
  "invalid-event": {
    title: "Invalid event",
    explain: "The body is not a valid offer event.",
    fix: "Send a well-formed offer event.",
  },
  "invalid-evidence": {
    title: "Invalid evidence",
    explain: "An evidence item is malformed or not allowed.",
    fix: "Fix the named item and upload again.",
  },
  "invalid-last-event-id": {
    title: "Invalid Last-Event-ID",
    explain: "The Last-Event-ID header is not a valid event id.",
    fix: "Reconnect with a valid Last-Event-ID or none.",
  },
  "invalid-limits": {
    title: "Invalid limits",
    explain: "The mandate limits are invalid, for example an end time in the past.",
    fix: "Correct the limits and retry.",
  },
  "invalid-mandate": {
    title: "Invalid mandate",
    explain: "The mandate is malformed or its signature does not verify.",
    fix: "Rebuild and sign the mandate, then retry.",
  },
  "invalid-oauth-query": {
    title: "Invalid consent request",
    explain: "The signed consent query is invalid or expired.",
    fix: "Restart the OAuth authorization flow.",
  },
  "invalid-order-report": {
    title: "Invalid order report",
    explain: "The order report is invalid. The transaction is recorded without it.",
    fix: "Fix the report as the detail describes and send it again.",
  },
  "invalid-origin": {
    title: "Invalid origin",
    explain: "An origin is malformed.",
    fix: "Use https://host[:port] with no path.",
  },
  "invalid-request": {
    title: "Invalid request",
    explain: "The request is invalid.",
    fix: "Check the detail and fix the request.",
  },
  "invalid-signature": {
    title: "Invalid signature",
    explain: "The webhook delivery is not signed correctly, or it is too old.",
    fix: "Check the signing secret and deliver promptly.",
  },
  "invalid-token": {
    title: "Invalid token",
    explain: "The access token is invalid or expired.",
    fix: "Obtain a new access token.",
  },
  "issuer-unavailable": {
    title: "The card issuer did not take the chargeback",
    explain: "The card issuer did not accept the chargeback.",
    fix: "Retry later.",
  },
  "judge-compiles-spent": {
    title: "Compiles spent",
    explain: "This Judge Mode session has used all its compiles.",
    fix: "Start a new Judge Mode session.",
  },
  "judges-full": {
    title: "Too many judges",
    explain: "All of today's Judge Mode slots are taken.",
    fix: "Try again tomorrow.",
  },
  "key-conflict": {
    title: "Key conflict",
    explain: "The key conflicts with one already registered.",
    fix: "Use a different key, or remove the existing one.",
  },
  "last-passkey": {
    title: "Last passkey",
    explain: "This is your only passkey, and you need one to sign.",
    fix: "Add another passkey before removing this one.",
  },
  "leg-refused": {
    title: "A leg refused the request",
    explain: "A TEE leg refused to sign the request.",
    fix: "Check the detail; the request may break the mandate.",
  },
  "limits-raised": {
    title: "Limits raised",
    explain: "A limit is above what the agent's request asked for. Raising it takes a new request.",
    fix: "Keep limits at or below the request, or have the agent ask again.",
  },
  "link-invalid": {
    title: "Link invalid",
    explain: "The link expired, was used or was replaced.",
    fix: "Go back to the app and try again.",
  },
  "link-used": {
    title: "Link used",
    explain: "This link signature was already used.",
    fix: "Have the owner sign a new link.",
  },
  "malformed-body": {
    title: "Malformed body",
    explain: "The request body could not be parsed.",
    fix: "Send valid JSON with the correct Content-Type.",
  },
  "mandate-binding-mismatch": {
    title: "Mandate binding mismatch",
    explain: "Fields that compiling fills, such as the operator's agent key, do not match.",
    fix: "Sign the mandate exactly as compiled.",
  },
  "mandate-ended": {
    title: "Mandate ended",
    explain: "The mandate is no longer active.",
    fix: "Ask the user for a new mandate.",
  },
  "mandate-exists": {
    title: "Mandate exists",
    explain: "This signed mandate is already stored.",
    fix: "Use the stored mandate.",
  },
  "mandate-hold-mandate": {
    title: "Mandate holds its budget",
    explain: "This mandate holds its whole budget once.",
    fix: "Countersign against the mandate's existing hold.",
  },
  "mandate-looser-than-request": {
    title: "Mandate looser than the request",
    explain: "The mandate grants more than the agent's request asked for.",
    fix: "Sign a mandate no looser than the request.",
  },
  "mandate-needs-renewal": {
    title: "Mandate needs renewal",
    explain:
      "Keelson's TEE keys moved under on-chain governance, so this mandate must be signed again.",
    fix: "Have the user sign the mandate again.",
  },
  "mandate-not-active": {
    title: "Mandate not active",
    explain: "The mandate cannot countersign, so this action is not available.",
    fix: "Use an active mandate.",
  },
  "mandate-not-signed": {
    title: "Mandate not signed",
    explain: "Only a signed mandate waiting for its hold can be held.",
    fix: "Sign the mandate first.",
  },
  "merchant-not-capturable": {
    title: "Merchant not capturable",
    explain: "Keelson cannot capture or hold funds for this mandate's merchant.",
    fix: "Countersign its purchases as live.",
  },
  "model-error": {
    title: "Model error",
    explain: "The model did not answer this request.",
    fix: "Retry the request.",
  },
  "no-agent": {
    title: "No such agent",
    explain: "The agent is not minted in the Identity registry of this chain.",
    fix: "Mint the agent first, or check the id and chain.",
  },
  "no-operator": {
    title: "No operator",
    explain: "No operator is linked to this agent or client.",
    fix: "Link an operator first.",
  },
  "no-spending-request": {
    title: "No spending request",
    explain: "There is no spending request for this action.",
    fix: "Create a spending request first.",
  },
  "nonce-used": {
    title: "Nonce used",
    explain: "The nonce is not higher than the merchant's last one.",
    fix: "Send a higher nonce.",
  },
  "not-allowed": {
    title: "Not allowed on chain",
    explain: "The on-chain contract does not allow this action.",
    fix: "Check the contract's permissions for this caller.",
  },
  "not-calibrated": {
    title: "Not calibrated",
    explain: "No finished red-team campaign exists to calibrate the risk model yet.",
    fix: "Retry after a campaign finishes.",
  },
  "not-captured": {
    title: "Not captured",
    explain: "Only a captured purchase can ship.",
    fix: "Capture the purchase first.",
  },
  "not-deployed": {
    title: "Not deployed",
    explain: "Keelson's contracts are not deployed on this chain.",
    fix: "Use a supported chain.",
  },
  "not-found": {
    title: "Not found",
    explain: "The requested resource does not exist.",
    fix: "Check the id or path.",
  },
  "not-grid-state": {
    title: "Not grid state",
    explain: "The schema describes fields outside the allowed grid state.",
    fix: "Limit the schema to the allowed features.",
  },
  "not-judge": {
    title: "Not a judge",
    explain: "This session is not a Judge Mode session.",
    fix: "Start Judge Mode first.",
  },
  "not-live": {
    title: "Not live",
    explain: "Keelson captures this purchase itself, so a live report is not accepted.",
    fix: "Let Keelson capture it.",
  },
  "not-mandate-agent": {
    title: "Not the mandate's agent",
    explain:
      "The closed mandate is not this mandate's, closed by its agent over this request and cart.",
    fix: "Send the closed mandate signed by this mandate's agent.",
  },
  "not-merchant": {
    title: "Not this merchant",
    explain: "The session is not this merchant's.",
    fix: "Sign in with this merchant's settlement wallet.",
  },
  "not-operator": {
    title: "Not an operator",
    explain: "No wallet of this session owns the linked agent.",
    fix: "Sign in with a wallet that owns the agent.",
  },
  "not-owner": {
    title: "Not the owner",
    explain: "The link is not signed by the agent's owner or its agent wallet.",
    fix: "Sign with the owner or agent wallet.",
  },
  "not-priced": {
    title: "Not priced",
    explain: "No covered purchase or mandate exists yet to price the operator's losses from.",
    fix: "Retry after covered activity exists.",
  },
  "not-rated": {
    title: "Not rated",
    explain: "No Keelson feedback names this coverage.",
    fix: "Retry after feedback is posted.",
  },
  "not-sealed": {
    title: "Not sealed",
    explain: "Only an .original item is encrypted, so there is nothing to decrypt.",
    fix: "Request decryption only for .original items.",
  },
  "not-settled": {
    title: "Not settled",
    explain: "A chargeback needs a transaction the card network has settled.",
    fix: "Retry after the transaction settles.",
  },
  "not-the-approved-cart": {
    title: "Not the approved cart",
    explain: "This mandate was approved for one cart only, and this is another.",
    fix: "Use the approved cart, or ask for a new mandate.",
  },
  "number-mismatch": {
    title: "Not your agent's number",
    explain: "The number picked does not match the one the agent shows, so the request was denied.",
    fix: "Have the agent make a new request.",
  },
  "number-not-matched": {
    title: "Number not matched",
    explain: "The number the agent shows has not been picked yet.",
    fix: "Pick the number your agent shows first.",
  },
  "observation-invalid": {
    title: "Observation invalid",
    explain: "The observation is invalid.",
    fix: "Check the detail and make a new observation.",
  },
  "operator-not-found": {
    title: "Not found",
    explain: "No linked operator has this agent id.",
    fix: "Check the agent id, or link an operator.",
  },
  "order-mismatch": {
    title: "Order mismatch",
    explain: "The order is not the one held for this mandate or request.",
    fix: "Use the held order id.",
  },
  "origin-not-allowed": {
    title: "Origin not allowed",
    explain: "The embed origin is not registered for this platform.",
    fix: "Register it with PUT /v1/embed/origins.",
  },
  "passkey-in-use": {
    title: "Passkey in use",
    explain: "A mandate signed with this passkey is still being proved.",
    fix: "Try again in a minute.",
  },
  "passkey-invalid": {
    title: "Passkey not accepted",
    explain: "The passkey was not accepted or could not be created.",
    fix: "Sign in with your passkey again.",
  },
  "passkey-required": {
    title: "Passkey required",
    explain: "The account has no passkey to sign with.",
    fix: "Add a passkey.",
  },
  "payload-too-large": {
    title: "Payload too large",
    explain: "The request body is too large.",
    fix: "Send a smaller body.",
  },
  "paypal-disagree": {
    title: "PayPal disagrees with the legs",
    explain: "PayPal's record disagrees with what the TEE legs signed.",
    fix: "Check the order in PayPal and retry with matching data.",
  },
  "paypal-refused": {
    title: "PayPal refused",
    explain: "PayPal refused the operation.",
    fix: "Check the detail from PayPal and fix the request.",
  },
  "paypal-unavailable": {
    title: "PayPal unavailable",
    explain: "PayPal did not answer or is not configured. A timeout is usually temporary.",
    fix: "Retry later.",
  },
  "paypal-webhook-unconfigured": {
    title: "PayPal webhook unconfigured",
    explain: "No PayPal webhook id is configured, so deliveries cannot be verified.",
    fix: "Ask the deployment operator to configure it.",
  },
  "per-purchase-mandate": {
    title: "Per-purchase mandate",
    explain: "This mandate holds each purchase separately.",
    fix: "Hold each purchase on its own.",
  },
  "prompt-too-long": {
    title: "Prompt too long",
    explain: "The prompt exceeds the maximum length.",
    fix: "Shorten the prompt.",
  },
  "prover-failed": {
    title: "Prover failed",
    explain: "The TLSNotary prover failed or did not answer.",
    fix: "Retry the request.",
  },
  "prover-unconfigured": {
    title: "Prover unconfigured",
    explain: "No prover is configured on this server.",
    fix: "Ask the deployment operator to configure one.",
  },
  "purchase-exists": {
    title: "Purchase exists",
    explain: "A purchase of this cart is in flight or was captured in the last ten minutes.",
    fix: "Check that purchase before retrying.",
  },
  "purchase-hold-mismatch": {
    title: "Purchase hold mismatch",
    explain: "The cart differs from the one held for this request.",
    fix: "Use the held cart.",
  },
  "rate-limited": {
    title: "Too many requests",
    explain: "Too many requests in the current window.",
    fix: "Retry after the time in the Retry-After header.",
  },
  "read-only": {
    title: "Read only",
    explain: "Judge Mode cannot change a merchant.",
    fix: "Use a regular session.",
  },
  "relayer-low-balance": {
    title: "Relayer balance low",
    explain: "The relayer's balance is too low to send transactions.",
    fix: "Retry later.",
  },
  "request-exists": {
    title: "Request exists",
    explain: "This request id was already used.",
    fix: "Use a new request id.",
  },
  "revocation-unavailable": {
    title: "Revocation unavailable",
    explain: "Token revocation cannot be checked now. This is temporary.",
    fix: "Try again shortly.",
  },
  "session-not-fresh": {
    title: "Session not fresh",
    explain: "This action needs a recent sign-in.",
    fix: "Sign in again.",
  },
  "several-operators": {
    title: "Several operators",
    explain: "This client is linked to more than one operator.",
    fix: "Use one client per agent.",
  },
  "signed-in": {
    title: "Already signed in",
    explain: "You are already signed in.",
    fix: "Sign out before starting Judge Mode.",
  },
  "simulation-reverted": {
    title: "Transaction would revert",
    explain: "The transaction would revert on chain, so it was not sent.",
    fix: "Fix the call per the revert reason.",
  },
  "store-not-allowed": {
    title: "Store not allowed",
    explain: "The store is not the website the mandate allows for this merchant.",
    fix: "Buy from the allowed store.",
  },
  "tee-contradiction": {
    title: "A leg contradicted itself",
    explain: "A TEE leg contradicted itself, so the request was not signed.",
    fix: "Retry; report it if it persists.",
  },
  "tee-divergence": {
    title: "The two TEE legs disagreed",
    explain: "The two TEE legs disagreed, so the request was not signed.",
    fix: "Retry; report it if it persists.",
  },
  "tee-unavailable": {
    title: "TEE unavailable",
    explain: "A TEE leg cannot sign now. This is temporary.",
    fix: "Retry later.",
  },
  "tee-unregistered-signer": {
    title: "A leg signed with a key the registry does not allow",
    explain: "A TEE leg signed with a key the registry does not allow.",
    fix: "Retry later; report it if it persists.",
  },
  timeout: {
    title: "Request timed out",
    explain: "The request timed out. This is temporary.",
    fix: "Retry the request.",
  },
  "timestamps-not-found": {
    title: "Not found",
    explain: "No timestamp exists for this hash.",
    fix: "Check the hash.",
  },
  "too-many-approvals": {
    title: "Too many approvals waiting",
    explain: "The user already has carts of this mandate waiting for approval.",
    fix: "Wait for the user to answer them.",
  },
  "too-many-streams": {
    title: "Too many streams",
    explain: "Too many concurrent streams are open.",
    fix: "Close a stream or try again later.",
  },
  "transaction-recorded": {
    title: "Transaction recorded",
    explain:
      "A different PayPal transaction id is already recorded for this purchase, or this one for another.",
    fix: "Report the correct transaction id.",
  },
  "transaction-reverted": {
    title: "Transaction reverted",
    explain: "The on-chain transaction reverted.",
    fix: "Check the revert reason and retry.",
  },
  unauthorized: {
    title: "Unauthorized",
    explain: "The request has no valid credentials or session.",
    fix: "Sign in or send a valid access token.",
  },
  "unsupported-media-type": {
    title: "Unsupported media type",
    explain: "The Content-Type is not supported here.",
    fix: "Send one of the media types in the detail.",
  },
  "url-pii": {
    title: "URL holds PII",
    explain: "The URL holds an email address or phone number, and it would be published.",
    fix: "Remove the personal data from the URL.",
  },
  "validation-failed": {
    title: "Validation failed",
    explain: "The request failed validation.",
    fix: "Fix the fields in the detail and retry.",
  },
  "web-fact-invalid": {
    title: "WebFact invalid",
    explain: "The WebFact failed a verification check.",
    fix: "Produce a new WebFact.",
  },
  "web-fact-mismatch": {
    title: "WebFact mismatch",
    explain: "The notarized endpoint is not this purchase's.",
    fix: "Notarize this purchase's product endpoint.",
  },
  "web-fact-refused": {
    title: "WebFact refused",
    explain: "The endpoint's response cannot be notarized.",
    fix: "Use a different source.",
  },
} as const satisfies Record<string, { title: string; explain: string; fix: string }>;

/** A problem type's slug. */
export type ProblemSlug = keyof typeof PROBLEM_TYPES;
