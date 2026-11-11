from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.mandate_purchase_amount import MandatePurchaseAmount
    from ..models.mandate_purchase_capture import MandatePurchaseCapture
    from ..models.mandate_purchase_card import MandatePurchaseCard
    from ..models.mandate_purchase_checks_item import MandatePurchaseChecksItem
    from ..models.mandate_purchase_coverage import MandatePurchaseCoverage
    from ..models.mandate_purchase_disputes_item import MandatePurchaseDisputesItem
    from ..models.mandate_purchase_failure import MandatePurchaseFailure
    from ..models.mandate_purchase_live import MandatePurchaseLive
    from ..models.mandate_purchase_reasons_item import MandatePurchaseReasonsItem


T = TypeVar("T", bound="MandatePurchase")


@_attrs_define
class MandatePurchase:
    """
    Attributes:
        id (str): The purchase's ULID, which is also its Alibi id.
        merchant_id (str):
        amount (MandatePurchaseAmount):
        created_at (datetime.datetime):
        state (str):
        disputes (list[MandatePurchaseDisputesItem]): PayPal disputes over the purchase; `GET /v1/disputes/{id}` has
            each.
        log_index (str | Unset): The leaf's index in the Alibi log.
        coverage (MandatePurchaseCoverage | Unset): The `lockCoverage` transaction of the operator's bond.
        capture (MandatePurchaseCapture | Unset): The PayPal capture of the countersigned amount.
        failure (MandatePurchaseFailure | Unset): The step that failed and why; nothing was captured.
        blocked (list[str] | Unset): For a `DENIED` cart, the mandate fields whose check failed.
        reasons (list[MandatePurchaseReasonsItem] | Unset): For a `DENIED` cart, each failed field with what the mandate
            allowed and what the cart had, as text.
        checks (list[MandatePurchaseChecksItem] | Unset): For a purchase the engine checked, each mandate field with
            what the mandate allowed, what the cart had and whether it held.
        card (MandatePurchaseCard | Unset): A card purchase: its single-use card (never its number) and every
            authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture
            settles.
        live (MandatePurchaseLive | Unset): A purchase the buyer pays at the store's own checkout: the store's origin
            and the PayPal transaction id once the agent recorded it. Never covered nor captured.
    """

    id: str
    merchant_id: str
    amount: MandatePurchaseAmount
    created_at: datetime.datetime
    state: str
    disputes: list[MandatePurchaseDisputesItem]
    log_index: str | Unset = UNSET
    coverage: MandatePurchaseCoverage | Unset = UNSET
    capture: MandatePurchaseCapture | Unset = UNSET
    failure: MandatePurchaseFailure | Unset = UNSET
    blocked: list[str] | Unset = UNSET
    reasons: list[MandatePurchaseReasonsItem] | Unset = UNSET
    checks: list[MandatePurchaseChecksItem] | Unset = UNSET
    card: MandatePurchaseCard | Unset = UNSET
    live: MandatePurchaseLive | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        merchant_id = self.merchant_id

        amount = self.amount.to_dict()

        created_at = self.created_at.isoformat()

        state = self.state

        disputes = []
        for disputes_item_data in self.disputes:
            disputes_item = disputes_item_data.to_dict()
            disputes.append(disputes_item)

        log_index = self.log_index

        coverage: dict[str, Any] | Unset = UNSET
        if not isinstance(self.coverage, Unset):
            coverage = self.coverage.to_dict()

        capture: dict[str, Any] | Unset = UNSET
        if not isinstance(self.capture, Unset):
            capture = self.capture.to_dict()

        failure: dict[str, Any] | Unset = UNSET
        if not isinstance(self.failure, Unset):
            failure = self.failure.to_dict()

        blocked: list[str] | Unset = UNSET
        if not isinstance(self.blocked, Unset):
            blocked = self.blocked

        reasons: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.reasons, Unset):
            reasons = []
            for reasons_item_data in self.reasons:
                reasons_item = reasons_item_data.to_dict()
                reasons.append(reasons_item)

        checks: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.checks, Unset):
            checks = []
            for checks_item_data in self.checks:
                checks_item = checks_item_data.to_dict()
                checks.append(checks_item)

        card: dict[str, Any] | Unset = UNSET
        if not isinstance(self.card, Unset):
            card = self.card.to_dict()

        live: dict[str, Any] | Unset = UNSET
        if not isinstance(self.live, Unset):
            live = self.live.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "merchantId": merchant_id,
                "amount": amount,
                "createdAt": created_at,
                "state": state,
                "disputes": disputes,
            }
        )
        if log_index is not UNSET:
            field_dict["logIndex"] = log_index
        if coverage is not UNSET:
            field_dict["coverage"] = coverage
        if capture is not UNSET:
            field_dict["capture"] = capture
        if failure is not UNSET:
            field_dict["failure"] = failure
        if blocked is not UNSET:
            field_dict["blocked"] = blocked
        if reasons is not UNSET:
            field_dict["reasons"] = reasons
        if checks is not UNSET:
            field_dict["checks"] = checks
        if card is not UNSET:
            field_dict["card"] = card
        if live is not UNSET:
            field_dict["live"] = live

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_purchase_amount import MandatePurchaseAmount
        from ..models.mandate_purchase_capture import MandatePurchaseCapture
        from ..models.mandate_purchase_card import MandatePurchaseCard
        from ..models.mandate_purchase_checks_item import MandatePurchaseChecksItem
        from ..models.mandate_purchase_coverage import MandatePurchaseCoverage
        from ..models.mandate_purchase_disputes_item import MandatePurchaseDisputesItem
        from ..models.mandate_purchase_failure import MandatePurchaseFailure
        from ..models.mandate_purchase_live import MandatePurchaseLive
        from ..models.mandate_purchase_reasons_item import MandatePurchaseReasonsItem

        d = dict(src_dict)
        id = d.pop("id")

        merchant_id = d.pop("merchantId")

        amount = MandatePurchaseAmount.from_dict(d.pop("amount"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        state = d.pop("state")

        disputes = []
        _disputes = d.pop("disputes")
        for disputes_item_data in _disputes:
            disputes_item = MandatePurchaseDisputesItem.from_dict(disputes_item_data)

            disputes.append(disputes_item)

        log_index = d.pop("logIndex", UNSET)

        _coverage = d.pop("coverage", UNSET)
        coverage: MandatePurchaseCoverage | Unset
        if isinstance(_coverage, Unset):
            coverage = UNSET
        else:
            coverage = MandatePurchaseCoverage.from_dict(_coverage)

        _capture = d.pop("capture", UNSET)
        capture: MandatePurchaseCapture | Unset
        if isinstance(_capture, Unset):
            capture = UNSET
        else:
            capture = MandatePurchaseCapture.from_dict(_capture)

        _failure = d.pop("failure", UNSET)
        failure: MandatePurchaseFailure | Unset
        if isinstance(_failure, Unset):
            failure = UNSET
        else:
            failure = MandatePurchaseFailure.from_dict(_failure)

        blocked = cast(list[str], d.pop("blocked", UNSET))

        _reasons = d.pop("reasons", UNSET)
        reasons: list[MandatePurchaseReasonsItem] | Unset = UNSET
        if _reasons is not UNSET:
            reasons = []
            for reasons_item_data in _reasons:
                reasons_item = MandatePurchaseReasonsItem.from_dict(reasons_item_data)

                reasons.append(reasons_item)

        _checks = d.pop("checks", UNSET)
        checks: list[MandatePurchaseChecksItem] | Unset = UNSET
        if _checks is not UNSET:
            checks = []
            for checks_item_data in _checks:
                checks_item = MandatePurchaseChecksItem.from_dict(checks_item_data)

                checks.append(checks_item)

        _card = d.pop("card", UNSET)
        card: MandatePurchaseCard | Unset
        if isinstance(_card, Unset):
            card = UNSET
        else:
            card = MandatePurchaseCard.from_dict(_card)

        _live = d.pop("live", UNSET)
        live: MandatePurchaseLive | Unset
        if isinstance(_live, Unset):
            live = UNSET
        else:
            live = MandatePurchaseLive.from_dict(_live)

        mandate_purchase = cls(
            id=id,
            merchant_id=merchant_id,
            amount=amount,
            created_at=created_at,
            state=state,
            disputes=disputes,
            log_index=log_index,
            coverage=coverage,
            capture=capture,
            failure=failure,
            blocked=blocked,
            reasons=reasons,
            checks=checks,
            card=card,
            live=live,
        )

        mandate_purchase.additional_properties = d
        return mandate_purchase

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
