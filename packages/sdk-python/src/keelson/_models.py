"""Models generated from openapi/keelson.public.json; do not edit."""

from __future__ import annotations

from enum import Enum, StrEnum
from typing import Annotated, Any

from pydantic import AnyUrl, AwareDatetime, BaseModel, ConfigDict, Field, RootModel
from typing_extensions import TypeAliasType


class State(StrEnum):
    started = "started"
    ended = "ended"


class AgentRun(BaseModel):
    state: State
    liveViewUrl: Annotated[
        AnyUrl | None,
        Field(description="Kernel's live view of the agent's browser, opened read-only."),
    ] = None


class Timestamp(BaseModel):
    tsa: str
    token: str


class AlibiReceipt(BaseModel):
    alibi_id: str
    leaf: Annotated[str, Field(description="The leaf bytes, base64.")]
    leaf_hash: Annotated[str, Field(description="The RFC 6962 leaf hash, unpadded base64url.")]
    tlog_proof: Annotated[str, Field(description="A c2sp.org/tlog-proof@v1 with cosignatures.")]
    anchor: dict[str, Any] | None = None
    timestamps: list[Timestamp]


class Verdict(StrEnum):
    verified = "verified"
    verified_unanchored = "verified-unanchored"
    verified_offline = "verified-offline"
    failed = "failed"
    incomplete = "incomplete"


class Status(StrEnum):
    pass_ = "pass"
    fail = "fail"
    undisclosed = "undisclosed"
    pending = "pending"
    absent = "absent"
    unreachable = "unreachable"


class Check(BaseModel):
    id: str
    step: int
    status: Status
    reason: str | None = None
    reads: Annotated[list[str], Field(description="RFC 6901 pointers the check read.")]
    ms: float
    detail: dict[str, str] | None = None


class Mode(StrEnum):
    field_2of2 = "2of2"
    degraded = "degraded"


class UnboundItem(BaseModel):
    pointer: str
    value: Any | None = None


class Rpc(BaseModel):
    url: str
    custom: bool


class AlibiReport(BaseModel):
    reference: str
    verdict: Verdict
    checks: list[Check]
    mode: Mode
    fields: list[dict[str, Any]]
    unbound: list[UnboundItem]
    changed: list[str]
    rpc: Rpc | None = None
    ms: float


class Attested(BaseModel):
    url: Annotated[AnyUrl, Field(description="The store's JSON page for the SKU.")]
    sku: str
    size: str
    color: str
    unit_minor: Annotated[str, Field(pattern="^\\d+$")]
    returns_free: bool


class FieldModel(StrEnum):
    size = "size"
    color = "color"
    unit_price = "unit_price"
    returns_free = "returns_free"


class PublicInput(RootModel[str]):
    root: Annotated[str, Field(pattern="^0x[0-9a-f]+$")]


class Proof(BaseModel):
    bytes: int
    hash: Annotated[str, Field(description="keccak256 of the proof.", pattern="^0x[0-9a-f]+$")]
    public_inputs: Annotated[
        list[PublicInput],
        Field(description="`range_hi, range_lo, amber_commitment, product, field_id`, as the court gave the verifier."),
    ]


class Conviction(BaseModel):
    field: FieldModel
    attested_value: Annotated[
        str | None,
        Field(
            description="What the operator attested of the field, which the store's answer contradicts. Null on the public dispute read."
        ),
    ]
    proven_at: AwareDatetime
    web_fact_digest: Annotated[
        str,
        Field(
            description="The EIP-712 digest of the `WebFact` leg A signed over the store's answer.",
            pattern="^0x[0-9a-f]+$",
        ),
    ]
    captured_at: AwareDatetime | None
    tx_hash: Annotated[str, Field(pattern="^0x[0-9a-f]+$")]
    explorer_url: AnyUrl
    proof: Proof | None


class AmberCase(BaseModel):
    commitment: Annotated[
        str,
        Field(
            description="The `amberCommitment` the operator signed into the coverage: Poseidon2 over the product page, the fields below and a salt.",
            pattern="^0x[0-9a-f]+$",
        ),
    ]
    attested: Annotated[
        Attested | None,
        Field(
            description="What the operator attested. Null on the public dispute read: what was bought stays with the consoles."
        ),
    ]
    conviction: Annotated[
        Conviction | None,
        Field(
            description="`AmberContradictionCourt`'s conviction on Arbitrum Sepolia: a C2b proof that the store's own answer, notarized by leg A, holds another value of `field`. Null while there is none."
        ),
    ]


class Line(BaseModel):
    sku: Annotated[str, Field(max_length=256)]
    size: Annotated[str | None, Field(max_length=256)] = None
    color: Annotated[str | None, Field(max_length=256)] = None
    category: Annotated[str, Field(max_length=256)]
    qty: Annotated[int, Field(gt=0)]
    unit_minor: Annotated[int, Field(ge=0)]


class Cart(BaseModel):
    merchant: Annotated[str, Field(max_length=256, min_length=1)]
    currency: Annotated[str, Field(max_length=3, min_length=3)]
    lines: Annotated[list[Line], Field(max_length=32, min_length=1)]
    return_days: Annotated[int, Field(ge=0)]
    returns_free: bool


class Blocker(BaseModel):
    code: Annotated[str, Field(examples=["field:total"])]
    field: str | None
    message: str
    next: Annotated[str, Field(description="What the agent does about it.")]


class Check1(BaseModel):
    field: str
    mandate: str | None
    cart: str | None
    pass_: Annotated[bool, Field(alias="pass")]


class CartCheck(BaseModel):
    canAttempt: Annotated[
        bool,
        Field(description="Whether a countersign of this cart would pass the mandate as it stands now."),
    ]
    needsApproval: Annotated[
        bool,
        Field(
            description="The cart passes, and is above the user's ask-me amount: the countersign pauses it for their one-time approval."
        ),
    ]
    blockers: list[Blocker]
    checks: list[Check1]


class CheckoutBreakdown(BaseModel):
    items: str
    tax: str
    shipping: str
    discount: str


class Kind(StrEnum):
    connect = "connect"
    once = "once"


class ConnectionApproved(BaseModel):
    mandate_id: str
    kind: Kind


class Currency(StrEnum):
    AUD = "AUD"
    BRL = "BRL"
    CAD = "CAD"
    CNY = "CNY"
    CZK = "CZK"
    DKK = "DKK"
    EUR = "EUR"
    HKD = "HKD"
    HUF = "HUF"
    ILS = "ILS"
    JPY = "JPY"
    MYR = "MYR"
    MXN = "MXN"
    TWD = "TWD"
    NZD = "NZD"
    NOK = "NOK"
    PHP = "PHP"
    PLN = "PLN"
    GBP = "GBP"
    SGD = "SGD"
    SEK = "SEK"
    CHF = "CHF"
    THB = "THB"
    USD = "USD"


class Merchant(StrEnum):
    mrc_runfast = "mrc_runfast"


class ConnectionLimits(BaseModel):
    currency: Currency | None = "USD"
    perPurchaseMinor: Annotated[
        int,
        Field(
            description="Most one purchase may cost, minor units.",
            gt=0,
            le=9007199254740991,
        ),
    ]
    totalMinor: Annotated[
        int,
        Field(
            description="Most all purchases may cost together.",
            gt=0,
            le=9007199254740991,
        ),
    ]
    merchants: Annotated[
        list[Merchant] | None,
        Field(
            description="Onboarded merchant ids; every one when left out.",
            max_length=1,
            min_length=1,
        ),
    ] = ["mrc_runfast"]
    until: Annotated[AwareDatetime, Field(description="When the mandate ends.")]
    askAboveMinor: Annotated[
        int | None,
        Field(
            description="Above this a purchase waits for the user's one-time approval, although the limits allow it.",
            gt=0,
            le=9007199254740991,
        ),
    ] = None


class ConnectionRequest(BaseModel):
    name: Annotated[str, Field(examples=["Claude Code"], max_length=64, min_length=1)]
    reason: Annotated[
        str,
        Field(
            description="Why the agent asks, in its own words; the user reads it before approving.",
            max_length=1000,
            min_length=100,
        ),
    ]
    limits: ConnectionLimits


class Kind1(StrEnum):
    connect = "connect"
    once = "once"
    change = "change"


class State1(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DENIED = "DENIED"
    EXPIRED = "EXPIRED"


class ConnectionRequestState(BaseModel):
    id: str
    kind: Kind1
    state: State1
    mandateId: Annotated[str | None, Field(description="The mandate the user signed.")]
    parentMandateId: str | None
    userCode: str
    approvalUrl: str
    matchNumber: int | None
    expiresAt: str
    interval: int
    operatorAgentId: Annotated[
        str,
        Field(description="The ERC-8004 agent id of the operator the mandate names, in decimal."),
    ]


class Error(StrEnum):
    authorization_pending = "authorization_pending"
    slow_down = "slow_down"
    access_denied = "access_denied"
    expired_token = "expired_token"
    invalid_grant = "invalid_grant"
    unsupported_grant_type = "unsupported_grant_type"


class ConnectionTokenError(BaseModel):
    error: Error
    error_description: str
    interval: int | None = None


class EvidenceAdditionalPropertyItem(RootModel[str]):
    root: Annotated[str, Field(max_length=256)]


EvidenceAdditionalProperty = TypeAliasType(
    "EvidenceAdditionalProperty",
    Annotated[list[EvidenceAdditionalPropertyItem], Field(max_length=8)],
)


class Live(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    store: Annotated[
        AnyUrl,
        Field(description="The store's origin: the origin of the website the mandate allows for the cart's merchant."),
    ]


class CountersignRequest(BaseModel):
    authorizationId: Annotated[
        str | None,
        Field(
            description="The PayPal authorization that holds the mandate's funds, or this request's own hold when the mandate holds each purchase separately; leg A reads it. Absent for a card mandate, whose purchase is paid with a single-use card issued after the ALLOW.",
            max_length=64,
            min_length=1,
        ),
    ] = None
    closedMandate: Annotated[
        str | None,
        Field(
            description="The open mandate closed by the agent's key binding over the request and cart. Required, except of an app acting for a user under a mandate of Keelson's hosted operator, which sends `mandateId` instead.",
            max_length=131072,
            min_length=1,
        ),
    ] = None
    mandateId: Annotated[
        str | None,
        Field(
            description="Only for an app acting for a user (`purchases:write`) under a mandate of Keelson's hosted operator that the user approved for it: Keelson closes the mandate with the hosted operator's key over `requestId` and this cart.",
            pattern="^[0-7][0-9A-HJKMNP-TV-Z]{25}$",
        ),
    ] = None
    requestId: Annotated[
        str | None,
        Field(
            description="With `mandateId`: the request ULID the closed mandate binds, and the purchase's id; a new one when left out.",
            pattern="^[0-7][0-9A-HJKMNP-TV-Z]{25}$",
        ),
    ] = None
    cart: Cart
    unit: Annotated[
        dict[str, Any],
        Field(
            description="The PayPal purchase unit the cart is checked against: `{amount}`, the checkout total the buyer pays as a PayPal Orders v2 amount, whose `breakdown` has the `item_total` of the cart's lines and, when the checkout charges them, `tax_total`, `shipping` and `discount`. Keelson countersigns `amount.value`, which must be `item_total + tax_total + shipping − discount`, and checks it against the mandate's budget. `handling`, `insurance` and `shipping_discount` are refused: fold them into `shipping`."
        ),
    ]
    evidence: Annotated[
        dict[str, EvidenceAdditionalProperty] | None,
        Field(
            description="Evidence sources per field. `channel3:` sources are refused here: the API adds them from the observation stored in the evidence.",
            validate_default=True,
        ),
    ] = {}
    evidenceRoot: Annotated[
        str,
        Field(
            description="The root of the evidence stored with `POST /v1/evidence` for this mandate.",
            pattern="^0x[0-9a-f]{64}$",
        ),
    ]
    live: Annotated[
        Live | None,
        Field(
            description="Only when the buyer pays at the store's own checkout with their own PayPal account: Keelson countersigns and logs the purchase and issues its Alibi, and neither covers nor captures it. Its Alibi is public once the PayPal transaction is recorded. The agent's pay click waits for an ALLOW; the agent then records PayPal's transaction id with `PUT /v1/purchases/{id}/paypal-transaction`."
        ),
    ] = None
    repeatOf: Annotated[
        str | None,
        Field(
            description="Only when the user asked to buy the same cart again: the id of the latest purchase of this cart under the mandate. Not needed once that purchase was denied or failed before capture, or was captured more than ten minutes ago. A retry after a lost answer never sends it: the `409 purchase-exists` answer names the purchase already made.",
            max_length=26,
            min_length=26,
        ),
    ] = None


class Decision(StrEnum):
    allow = "allow"
    deny = "deny"


class Signatures(BaseModel):
    tdx: Annotated[str, Field(pattern="^0x[0-9a-f]{130}$")]
    nitro: Annotated[str | None, Field(pattern="^0x[0-9a-f]{130}$")]


class Signers(BaseModel):
    tdx: str
    nitro: str | None


class Coverage(BaseModel):
    chainId: int
    txHash: str | None


class Capture(BaseModel):
    id: str
    invoiceId: str
    status: str | None


class Failure(BaseModel):
    step: str
    reason: str


class Reason(BaseModel):
    field: str
    mandate: str | None
    cart: str | None


class Legs(BaseModel):
    tdx: bool
    nitro: bool


class Authorization(BaseModel):
    id: str
    amountMinor: str
    currency: str
    mcc: str
    merchantName: str
    merchantCountry: str
    approved: bool
    failedMask: int
    reason: str | None
    legs: Legs
    latencyMs: int
    at: str


class Card(BaseModel):
    issuer: str
    lastFour: str
    state: str
    expiresAt: str
    controls: dict[str, Any]
    settledMinor: str | None
    chargebacks: Annotated[
        list[dict[str, Any]],
        Field(description="Chargebacks filed through the card issuer over this purchase."),
    ]
    bondClaimMinor: Annotated[
        str,
        Field(
            description="The most a bond claim over this purchase may pay: the settled amount less what chargebacks returned; 0 while one is open."
        ),
    ]
    authorizations: list[Authorization]


class Live1(BaseModel):
    store: str
    transactionId: str | None


class DeviceAuthorization(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    request_id: Annotated[
        str,
        Field(
            description="The request's id: `GET /v1/connections/requests/{id}` reads its state without spending the device code."
        ),
    ]
    match_number: Annotated[
        int | None,
        Field(
            description="Show it beside the link: the user picks it out of three before the request opens, so a link relayed by someone else does not.",
            ge=10,
            le=99,
        ),
    ] = None


class State2(StrEnum):
    OPEN = "OPEN"
    ATTRIBUTED = "ATTRIBUTED"
    RESOLVED = "RESOLVED"


class Liable(Enum):
    operator = "operator"
    keelson = "keelson"
    merchant = "merchant"
    user = "user"
    NoneType_None = None


class Party1(StrEnum):
    operator = "operator"
    keelson = "keelson"
    merchant = "merchant"


class Party(BaseModel):
    party: Party1
    liable: bool


class Signature(BaseModel):
    tee: int
    signer: str
    signature: str


class Verdict1(BaseModel):
    rule: Annotated[str, Field(examples=["R61"])]
    digest: str
    chain_id: int
    message: dict[str, str]
    signatures: list[Signature]
    facts: dict[str, str | bool]


class Rail(StrEnum):
    pyusd = "pyusd"
    paypal = "paypal"


class Outcome(Enum):
    paid = "paid"
    queued = "queued"
    claimable = "claimable"
    failed = "failed"
    NoneType_None = None


class PaidBy(Enum):
    chain = "chain"
    treasury = "treasury"
    violation_pool = "violation-pool"
    NoneType_None = None


class Settlement(BaseModel):
    rail: Annotated[
        Rail,
        Field(
            description="`pyusd`: the payee the verdict names is the merchant. `paypal`: it is Keelson's treasury, which pays the merchant a PayPal Payout."
        ),
    ]
    outcome: Annotated[
        Outcome | None,
        Field(
            description="`queued`: the slash waits out the veto window until `ready_at`. `claimable`: the PYUSD transfer failed and waits as a claim. Null until the chain answered; always null when neither the operator nor Keelson is liable."
        ),
    ]
    failure: Annotated[
        str | None,
        Field(
            description="The contract error that refused the settlement on chain: of a `failed` one, or of one Keelson's treasury paid instead."
        ),
    ]
    paid_by: Annotated[
        PaidBy | None,
        Field(
            description="`chain`: the operator's bond or Keelson's reserve paid. `violation-pool`: the operator's `ViolationBondPool` deposit paid the merchant on a court's conviction, with no verdict. `treasury`: the chain refused a verdict that still holds (its window or deadline had passed), so Keelson's treasury pays the payee itself, PYUSD on chain or a PayPal Payout; the settlement is paid once `outcome` is `paid`."
        ),
    ]
    refund_id: Annotated[
        str | None,
        Field(description="The buyer's PayPal refund; its `custom_id` is the verdict's `ksv1.` reference."),
    ]
    tx_hash: str | None
    explorer_url: str | None
    ready_at: AwareDatetime | None
    payout_batch_id: str | None
    payout_status: str | None
    settled_at: AwareDatetime | None


class Action(StrEnum):
    provide_evidence = "provide_evidence"
    send_message = "send_message"
    accept_claim = "accept_claim"


class DraftedBy(Enum):
    model = "model"
    template = "template"
    NoneType_None = None


class Response(BaseModel):
    action: Action
    stage: Annotated[str, Field(description="PayPal's lifecycle stage when it was sent.")]
    evidence_types: list[str]
    drafted_by: Annotated[
        DraftedBy | None,
        Field(
            description="`model` when the statement was drafted with citations; `template` when the rule's fixed statement was sent. Null for an accepted claim."
        ),
    ]
    citations: Annotated[
        int,
        Field(
            description="How many passages of the Alibi and the verdict the statement cites. The statement itself is not public: it quotes the purchase's Alibi."
        ),
    ]
    sent_at: AwareDatetime


class DisputeStatus(BaseModel):
    dispute_id: str
    purchase_id: str
    state: State2
    reason: Annotated[str, Field(description="PayPal's `dispute_reason`.")]
    received_at: Annotated[
        AwareDatetime | None,
        Field(description="When Keelson received the dispute's first webhook or poll."),
    ]
    attributed_at: AwareDatetime | None
    elapsed_ms: Annotated[
        int | None,
        Field(description="From `received_at` to `attributed_at`; null while the dispute is open."),
    ]
    liable: Liable | None
    parties: Annotated[
        list[Party],
        Field(
            description="The parties a verdict can make pay: the operator's bond, Keelson's reserve, or the merchant through PayPal."
        ),
    ]
    verdict: Verdict1 | None
    settlement: Settlement | None
    responses: Annotated[
        list[Response],
        Field(
            description="What Keelson sent PayPal for the party at fault. The action and the evidence types follow from the rule; a model only drafts the text."
        ),
    ]
    amber: AmberCase | None


class V(StrEnum):
    keelson_manifest_1 = "keelson.manifest/1"


class Item(BaseModel):
    type: str
    media_type: str
    leaf: Annotated[
        str,
        Field(
            description='`SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖ content_hash)`.',
            pattern="^0x[0-9a-f]{64}$",
        ),
    ]


class EvidenceManifest(BaseModel):
    v: V
    root: Annotated[str, Field(pattern="^0x[0-9a-f]{64}$")]
    items: Annotated[list[Item], Field(max_length=24, min_length=1)]


class Item1(BaseModel):
    type: Annotated[str, Field(max_length=64)]
    mediaType: Annotated[str, Field(max_length=128)]
    salt: Annotated[str, Field(description="32 random bytes, base64.")]
    bytes: Annotated[str, Field(description="The item bytes, base64.")]


class EvidenceUpload(BaseModel):
    mandateId: Annotated[str, Field(max_length=26, min_length=26)]
    manifest: EvidenceManifest
    items: Annotated[list[Item1], Field(max_length=24, min_length=1)]


class ChainId(Enum):
    number_421614 = 421614


class ChainId1(Enum):
    number_42161 = 42161


class ChainId2(Enum):
    number_11155111 = 11155111


class Kty(StrEnum):
    EC = "EC"


class Crv(StrEnum):
    P_256 = "P-256"


class CnfJwk(BaseModel):
    kty: Kty
    crv: Crv
    x: Annotated[str, Field(pattern="^[A-Za-z0-9_-]{43}$")]
    y: Annotated[str, Field(pattern="^[A-Za-z0-9_-]{43}$")]
    kid: Annotated[str | None, Field(max_length=64)] = None


class LinkOperator(BaseModel):
    chainId: ChainId | ChainId1 | ChainId2
    agentId: Annotated[
        str,
        Field(
            description="The ERC-8004 agent id, a decimal integer.",
            pattern="^(0|[1-9]\\d{0,19})$",
        ),
    ]
    name: Annotated[str, Field(max_length=200, min_length=1)]
    cnfJwk: Annotated[CnfJwk, Field(description="The agent's P-256 `cnf` key, a public JWK.")]
    deadline: Annotated[int, Field(description="Unix seconds, at most 15 minutes ahead.", gt=0)]
    signature: Annotated[
        str,
        Field(
            description='The EIP-712 `OperatorLink(uint256 agentId,bytes32 cnfThumbprint,uint256 deadline)` signature under the domain `{ name: "Keelson", version: "1", chainId }`, by the agent\'s owner or `agentWallet` (EOA, ERC-1271 or ERC-6492). `cnfThumbprint` is the RFC 7638 SHA-256 thumbprint of `cnfJwk`.',
            max_length=8194,
            pattern="^0x([0-9a-fA-F]{2})+$",
        ),
    ]


class Limits(BaseModel):
    perPurchaseMinor: Annotated[int | None, Field(gt=0, le=9007199254740991)] = None
    totalMinor: Annotated[int | None, Field(gt=0, le=9007199254740991)] = None
    until: AwareDatetime | None = None
    askAboveMinor: Annotated[int | None, Field(gt=0, le=9007199254740991)] = None


class MandateChangeRequest(BaseModel):
    note: Annotated[
        str,
        Field(
            description="Why the agent needs more room, in one line the user reads verbatim, e.g. 'Needs $40 more for shipping'.",
            max_length=280,
            min_length=10,
        ),
    ]
    limits: Annotated[
        Limits | None,
        Field(description="The limits asked for; the mandate's own where left out."),
    ] = None


class OnceApproval(BaseModel):
    device_code: Annotated[
        str | None,
        Field(
            description="Absent when the user is already being asked about this cart: keep polling the device code you were given then."
        ),
    ] = None
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    request_id: Annotated[
        str,
        Field(description="Read the request's state with `GET /v1/connections/requests/{id}`."),
    ]


class Operator(BaseModel):
    agentId: Annotated[
        str,
        Field(
            description="The ERC-8004 agent id, a decimal integer.",
            pattern="^(0|[1-9]\\d{0,19})$",
        ),
    ]
    chainId: int
    agentRegistry: str
    owner: Annotated[str, Field(description="The agent's owner in the Identity registry.")]


class State3(StrEnum):
    ACTIVE = "ACTIVE"


class HoldMode(Enum):
    mandate = "mandate"
    per_purchase = "per_purchase"
    NoneType_None = None


class OperatorMandate(BaseModel):
    id: str
    state: State3
    currency: str
    maxMinor: int
    remainingMinor: int
    expiresAt: AwareDatetime
    holdMode: HoldMode | None
    authorizationId: Annotated[
        str | None,
        Field(
            description="The PayPal authorization that holds the mandate's funds, when the mandate is held as a whole."
        ),
    ]
    openMandate: Annotated[
        str,
        Field(description="The mandate as issued, which the agent closes with its `cnf` key for each countersign."),
    ]


class Problem(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    __annotations__ = {
        "__pydantic_extra__": dict[str, Any],
    }
    type: AnyUrl
    title: str
    status: int
    detail: str | None = None
    instance: str


class Mode2(Enum):
    field_2of2 = "2of2"
    degraded = "degraded"
    NoneType_None = None


class Amount(BaseModel):
    currency: str
    minor: str
    breakdown: CheckoutBreakdown | None = None


class Authorization1(BaseModel):
    id: str
    amountMinor: str
    currency: str
    mcc: str
    merchantName: str
    merchantCountry: str
    approved: bool
    failedMask: int
    reason: str | None
    legs: Legs
    latencyMs: int
    at: str


class Card1(BaseModel):
    issuer: str
    lastFour: str
    state: str
    expiresAt: str
    controls: dict[str, Any]
    settledMinor: str | None
    chargebacks: Annotated[
        list[dict[str, Any]],
        Field(description="Chargebacks filed through the card issuer over this purchase."),
    ]
    bondClaimMinor: Annotated[
        str,
        Field(
            description="The most a bond claim over this purchase may pay: the settled amount less what chargebacks returned; 0 while one is open."
        ),
    ]
    authorizations: list[Authorization1]


class Purchase(BaseModel):
    id: str
    mandateId: str
    mode: Mode2 | None
    amount: Amount
    state: str
    logIndex: Annotated[str | None, Field(description="The leaf's index in the Alibi log.")] = None
    coverage: Annotated[
        Coverage | None,
        Field(description="The `lockCoverage` transaction of the operator's bond."),
    ] = None
    capture: Annotated[
        Capture | None,
        Field(description="The PayPal capture of the countersigned amount."),
    ] = None
    failure: Annotated[
        Failure | None,
        Field(description="The step that failed and why; nothing was captured."),
    ] = None
    blocked: Annotated[
        list[str] | None,
        Field(description="For a `DENIED` cart, the mandate fields whose check failed."),
    ] = None
    reasons: Annotated[
        list[Reason] | None,
        Field(
            description="For a `DENIED` cart, each failed field with what the mandate allowed and what the cart had, as text."
        ),
    ] = None
    checks: Annotated[
        list[Check1] | None,
        Field(
            description="For a purchase the engine checked, each mandate field with what the mandate allowed, what the cart had and whether it held."
        ),
    ] = None
    card: Annotated[
        Card1 | None,
        Field(
            description="A card purchase: its single-use card (never its number) and every authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture settles."
        ),
    ] = None
    live: Annotated[
        Live1 | None,
        Field(
            description="A purchase the buyer pays at the store's own checkout: the store's origin and the PayPal transaction id once the agent recorded it. Never covered nor captured."
        ),
    ] = None


class Tee(StrEnum):
    tdx = "tdx"
    nitro = "nitro"


class Onchain(BaseModel):
    chainId: float
    verdictVerifier: str
    registeredAt: str
    expiresAt: str


class TeeLeg(BaseModel):
    tee: Tee
    signer: str
    measurement: str
    registeredAt: str
    verifiedAt: Annotated[str, Field(description="When the attestation last verified.")]
    expiresAt: str
    onchain: Annotated[
        Onchain | None,
        Field(
            description="The signer's record in the VerdictVerifier, which on-chain verification reads; null when it is not registered there."
        ),
    ]
    attestation: Annotated[
        dict[str, Any],
        Field(
            description="The attestation the signer was admitted from: the platform evidence, its binding and the block it was made over."
        ),
    ]


class Tsa(StrEnum):
    digicert = "digicert"
    sigstore = "sigstore"
    freetsa = "freetsa"
    sectigo = "sectigo"


class Role(StrEnum):
    primary = "primary"
    fallback = "fallback"


class Timestamp1(BaseModel):
    tsa: Tsa
    role: Role
    token: Annotated[str, Field(description="The DER `TimeStampToken`, base64.")]
    genTime: Annotated[str, Field(description="The token's `genTime`, RFC 3339 UTC.")]
    serial: Annotated[str, Field(description="The token's serial number, hex.")]


class V1(StrEnum):
    keelson_grade_1 = "keelson.grade/1"


class Grade(StrEnum):
    A = "A"
    B = "B"
    C = "C"
    D = "D"
    F = "F"


class Calibration(BaseModel):
    id: str
    at: AwareDatetime
    campaigns: Annotated[list[str], Field(description="The red-team campaigns pooled.")]
    mu_ppm: Annotated[int, Field(description="The prior's mean, ASR × escape + amber.")]
    kappa: Annotated[float, Field(description="The prior's strength, by the method of moments.")]


class Incidents(BaseModel):
    total: int
    slashes: Annotated[int, Field(description="Paid from the operator's bond.")]
    pool: Annotated[int, Field(description="Paid from its `ViolationBondPool` deposit.")]
    uncollected: Annotated[int, Field(description="Paid by Keelson's treasury instead.")]
    pending: Annotated[int, Field(description="Not settled yet.")]


class Evidence(BaseModel):
    coverages: int
    incidents: Annotated[
        Incidents,
        Field(description="Verdicts with the operator at fault: what the grade counts."),
    ]


class Reserve(BaseModel):
    warranties: int


class Frequency(BaseModel):
    alpha: float
    beta: float
    credibility_ppm: int
    mean_ppm: int
    upper95_ppm: int


class Severity(BaseModel):
    meanMinor: int
    maxMinor: int
    lossRatio_ppm: int


class Loss(BaseModel):
    horizon: int
    scenarios: int
    expectedMinor: int
    var99Minor: int
    es99Minor: int
    var995Minor: int


class Premium(BaseModel):
    bps: Annotated[int, Field(description="Charged on each new coverage, in `lockCoverage`.")]
    modelBps: int
    floorBps: int
    theta: float
    costOfCapital: float


class Bond(BaseModel):
    requiredMinor: int


class TrustGrade(BaseModel):
    v: V1
    agentId: str
    grade: Annotated[
        Grade,
        Field(
            description="From the one-sided 95 % credible upper bound of the incident rate: A ≤ 1 %, B ≤ 2 %, C ≤ 5 %, D ≤ 10 %, F above."
        ),
    ]
    computedAt: AwareDatetime
    calibration: Calibration
    evidence: Evidence
    reserve: Annotated[
        Reserve,
        Field(description="Keelson's own faults on the operator's coverages, paid by its reserve. Not in the grade."),
    ]
    frequency: Frequency
    severity: Severity
    loss: Loss
    premium: Premium
    bond: Bond
    computeMs: float


class Countersigned(BaseModel):
    purchaseId: str
    mode: Annotated[
        Mode,
        Field(description="`degraded` when leg B was unreachable and only leg A signed."),
    ]
    decision: Decision
    countersign: Annotated[
        dict[str, str],
        Field(description="The EIP-712 `Countersign` message, as decimal strings."),
    ]
    digest: Annotated[str, Field(pattern="^0x[0-9a-f]{64}$")]
    signatures: Signatures
    signers: Signers
    trace: Annotated[
        Any | None,
        Field(description="The `keelson.eval/1` trace both legs signed over."),
    ] = None
    approval: OnceApproval | None = None
    state: Annotated[
        str | None,
        Field(
            description="`CAPTURED` once logged, covered and captured; `FAILED` with `failure` when a step refused; `COUNTERSIGNED`, `LOGGED` or `COVERED` while a step is pending; `DENIED` for a DENY."
        ),
    ] = None
    logIndex: Annotated[str | None, Field(description="The leaf's index in the Alibi log.")] = None
    coverage: Annotated[
        Coverage | None,
        Field(description="The `lockCoverage` transaction of the operator's bond."),
    ] = None
    capture: Annotated[
        Capture | None,
        Field(description="The PayPal capture of the countersigned amount."),
    ] = None
    failure: Annotated[
        Failure | None,
        Field(description="The step that failed and why; nothing was captured."),
    ] = None
    blocked: Annotated[
        list[str] | None,
        Field(description="For a `DENIED` cart, the mandate fields whose check failed."),
    ] = None
    reasons: Annotated[
        list[Reason] | None,
        Field(
            description="For a `DENIED` cart, each failed field with what the mandate allowed and what the cart had, as text."
        ),
    ] = None
    checks: Annotated[
        list[Check1] | None,
        Field(
            description="For a purchase the engine checked, each mandate field with what the mandate allowed, what the cart had and whether it held."
        ),
    ] = None
    card: Annotated[
        Card | None,
        Field(
            description="A card purchase: its single-use card (never its number) and every authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture settles."
        ),
    ] = None
    live: Annotated[
        Live1 | None,
        Field(
            description="A purchase the buyer pays at the store's own checkout: the store's origin and the PayPal transaction id once the agent recorded it. Never covered nor captured."
        ),
    ] = None
