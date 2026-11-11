from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.cart import Cart
    from ..models.countersign_request_evidence import CountersignRequestEvidence
    from ..models.countersign_request_live import CountersignRequestLive
    from ..models.countersign_request_unit import CountersignRequestUnit


T = TypeVar("T", bound="CountersignRequest")


@_attrs_define
class CountersignRequest:
    """
    Attributes:
        cart (Cart):
        unit (CountersignRequestUnit): The PayPal purchase unit the cart is checked against: `{amount}`, the checkout
            total the buyer pays as a PayPal Orders v2 amount, whose `breakdown` has the `item_total` of the cart's lines
            and, when the checkout charges them, `tax_total`, `shipping` and `discount`. Keelson countersigns
            `amount.value`, which must be `item_total + tax_total + shipping − discount`, and checks it against the
            mandate's budget. `handling`, `insurance` and `shipping_discount` are refused: fold them into `shipping`.
        evidence_root (str): The root of the evidence stored with `POST /v1/evidence` for this mandate.
        authorization_id (str | Unset): The PayPal authorization that holds the mandate's funds, or this request's own
            hold when the mandate holds each purchase separately; leg A reads it. Absent for a card mandate, whose purchase
            is paid with a single-use card issued after the ALLOW.
        closed_mandate (str | Unset): The open mandate closed by the agent's key binding over the request and cart.
            Required, except of an app acting for a user under a mandate of Keelson's hosted operator, which sends
            `mandateId` instead.
        mandate_id (str | Unset): Only for an app acting for a user (`purchases:write`) under a mandate of Keelson's
            hosted operator that the user approved for it: Keelson closes the mandate with the hosted operator's key over
            `requestId` and this cart.
        request_id (str | Unset): With `mandateId`: the request ULID the closed mandate binds, and the purchase's id; a
            new one when left out.
        evidence (CountersignRequestEvidence | Unset): Evidence sources per field. `channel3:` sources are refused here:
            the API adds them from the observation stored in the evidence.
        live (CountersignRequestLive | Unset): Only when the buyer pays at the store's own checkout with their own
            PayPal account: Keelson countersigns and logs the purchase and issues its Alibi, and neither covers nor captures
            it. Its Alibi is public once the PayPal transaction is recorded. The agent's pay click waits for an ALLOW; the
            agent then records PayPal's transaction id with `PUT /v1/purchases/{id}/paypal-transaction`.
        repeat_of (str | Unset): Only when the user asked to buy the same cart again: the id of the latest purchase of
            this cart under the mandate. Not needed once that purchase was denied or failed before capture, or was captured
            more than ten minutes ago. A retry after a lost answer never sends it: the `409 purchase-exists` answer names
            the purchase already made.
    """

    cart: Cart
    unit: CountersignRequestUnit
    evidence_root: str
    authorization_id: str | Unset = UNSET
    closed_mandate: str | Unset = UNSET
    mandate_id: str | Unset = UNSET
    request_id: str | Unset = UNSET
    evidence: CountersignRequestEvidence | Unset = UNSET
    live: CountersignRequestLive | Unset = UNSET
    repeat_of: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        cart = self.cart.to_dict()

        unit = self.unit.to_dict()

        evidence_root = self.evidence_root

        authorization_id = self.authorization_id

        closed_mandate = self.closed_mandate

        mandate_id = self.mandate_id

        request_id = self.request_id

        evidence: dict[str, Any] | Unset = UNSET
        if not isinstance(self.evidence, Unset):
            evidence = self.evidence.to_dict()

        live: dict[str, Any] | Unset = UNSET
        if not isinstance(self.live, Unset):
            live = self.live.to_dict()

        repeat_of = self.repeat_of

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "cart": cart,
                "unit": unit,
                "evidenceRoot": evidence_root,
            }
        )
        if authorization_id is not UNSET:
            field_dict["authorizationId"] = authorization_id
        if closed_mandate is not UNSET:
            field_dict["closedMandate"] = closed_mandate
        if mandate_id is not UNSET:
            field_dict["mandateId"] = mandate_id
        if request_id is not UNSET:
            field_dict["requestId"] = request_id
        if evidence is not UNSET:
            field_dict["evidence"] = evidence
        if live is not UNSET:
            field_dict["live"] = live
        if repeat_of is not UNSET:
            field_dict["repeatOf"] = repeat_of

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cart import Cart
        from ..models.countersign_request_evidence import CountersignRequestEvidence
        from ..models.countersign_request_live import CountersignRequestLive
        from ..models.countersign_request_unit import CountersignRequestUnit

        d = dict(src_dict)
        cart = Cart.from_dict(d.pop("cart"))

        unit = CountersignRequestUnit.from_dict(d.pop("unit"))

        evidence_root = d.pop("evidenceRoot")

        authorization_id = d.pop("authorizationId", UNSET)

        closed_mandate = d.pop("closedMandate", UNSET)

        mandate_id = d.pop("mandateId", UNSET)

        request_id = d.pop("requestId", UNSET)

        _evidence = d.pop("evidence", UNSET)
        evidence: CountersignRequestEvidence | Unset
        if isinstance(_evidence, Unset):
            evidence = UNSET
        else:
            evidence = CountersignRequestEvidence.from_dict(_evidence)

        _live = d.pop("live", UNSET)
        live: CountersignRequestLive | Unset
        if isinstance(_live, Unset):
            live = UNSET
        else:
            live = CountersignRequestLive.from_dict(_live)

        repeat_of = d.pop("repeatOf", UNSET)

        countersign_request = cls(
            cart=cart,
            unit=unit,
            evidence_root=evidence_root,
            authorization_id=authorization_id,
            closed_mandate=closed_mandate,
            mandate_id=mandate_id,
            request_id=request_id,
            evidence=evidence,
            live=live,
            repeat_of=repeat_of,
        )

        countersign_request.additional_properties = d
        return countersign_request

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
