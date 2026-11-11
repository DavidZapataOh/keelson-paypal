from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.purchase_mode_type_1 import PurchaseModeType1, check_purchase_mode_type_1
from ..models.purchase_mode_type_2_type_1 import (
    PurchaseModeType2Type1,
    check_purchase_mode_type_2_type_1,
)
from ..models.purchase_mode_type_3_type_1 import (
    PurchaseModeType3Type1,
    check_purchase_mode_type_3_type_1,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.purchase_amount import PurchaseAmount
    from ..models.purchase_capture import PurchaseCapture
    from ..models.purchase_card_detail import PurchaseCardDetail
    from ..models.purchase_checks_item import PurchaseChecksItem
    from ..models.purchase_coverage import PurchaseCoverage
    from ..models.purchase_failure import PurchaseFailure
    from ..models.purchase_live import PurchaseLive
    from ..models.purchase_reasons_item import PurchaseReasonsItem


T = TypeVar("T", bound="Purchase")


@_attrs_define
class Purchase:
    """
    Attributes:
        id (str):
        mandate_id (str):
        mode (None | PurchaseModeType1 | PurchaseModeType2Type1 | PurchaseModeType3Type1):
        amount (PurchaseAmount):
        state (str):
        log_index (str | Unset): The leaf's index in the Alibi log.
        coverage (PurchaseCoverage | Unset): The `lockCoverage` transaction of the operator's bond.
        capture (PurchaseCapture | Unset): The PayPal capture of the countersigned amount.
        failure (PurchaseFailure | Unset): The step that failed and why; nothing was captured.
        blocked (list[str] | Unset): For a `DENIED` cart, the mandate fields whose check failed.
        reasons (list[PurchaseReasonsItem] | Unset): For a `DENIED` cart, each failed field with what the mandate
            allowed and what the cart had, as text.
        checks (list[PurchaseChecksItem] | Unset): For a purchase the engine checked, each mandate field with what the
            mandate allowed, what the cart had and whether it held.
        card (PurchaseCardDetail | Unset): A card purchase: its single-use card (never its number) and every
            authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture
            settles.
        live (PurchaseLive | Unset): A purchase the buyer pays at the store's own checkout: the store's origin and the
            PayPal transaction id once the agent recorded it. Never covered nor captured.
    """

    id: str
    mandate_id: str
    mode: PurchaseModeType1 | PurchaseModeType2Type1 | PurchaseModeType3Type1 | None
    amount: PurchaseAmount
    state: str
    log_index: str | Unset = UNSET
    coverage: PurchaseCoverage | Unset = UNSET
    capture: PurchaseCapture | Unset = UNSET
    failure: PurchaseFailure | Unset = UNSET
    blocked: list[str] | Unset = UNSET
    reasons: list[PurchaseReasonsItem] | Unset = UNSET
    checks: list[PurchaseChecksItem] | Unset = UNSET
    card: PurchaseCardDetail | Unset = UNSET
    live: PurchaseLive | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        mandate_id = self.mandate_id

        mode: str | None
        if isinstance(self.mode, str) or isinstance(self.mode, str) or isinstance(self.mode, str):
            mode = self.mode
        else:
            mode = self.mode

        amount = self.amount.to_dict()

        state = self.state

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
                "mandateId": mandate_id,
                "mode": mode,
                "amount": amount,
                "state": state,
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
        from ..models.purchase_amount import PurchaseAmount
        from ..models.purchase_capture import PurchaseCapture
        from ..models.purchase_card_detail import PurchaseCardDetail
        from ..models.purchase_checks_item import PurchaseChecksItem
        from ..models.purchase_coverage import PurchaseCoverage
        from ..models.purchase_failure import PurchaseFailure
        from ..models.purchase_live import PurchaseLive
        from ..models.purchase_reasons_item import PurchaseReasonsItem

        d = dict(src_dict)
        id = d.pop("id")

        mandate_id = d.pop("mandateId")

        def _parse_mode(
            data: object,
        ) -> PurchaseModeType1 | PurchaseModeType2Type1 | PurchaseModeType3Type1 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                mode_type_1 = check_purchase_mode_type_1(data)

                return mode_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                mode_type_2_type_1 = check_purchase_mode_type_2_type_1(data)

                return mode_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                mode_type_3_type_1 = check_purchase_mode_type_3_type_1(data)

                return mode_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                None | PurchaseModeType1 | PurchaseModeType2Type1 | PurchaseModeType3Type1, data
            )

        mode = _parse_mode(d.pop("mode"))

        amount = PurchaseAmount.from_dict(d.pop("amount"))

        state = d.pop("state")

        log_index = d.pop("logIndex", UNSET)

        _coverage = d.pop("coverage", UNSET)
        coverage: PurchaseCoverage | Unset
        if isinstance(_coverage, Unset):
            coverage = UNSET
        else:
            coverage = PurchaseCoverage.from_dict(_coverage)

        _capture = d.pop("capture", UNSET)
        capture: PurchaseCapture | Unset
        if isinstance(_capture, Unset):
            capture = UNSET
        else:
            capture = PurchaseCapture.from_dict(_capture)

        _failure = d.pop("failure", UNSET)
        failure: PurchaseFailure | Unset
        if isinstance(_failure, Unset):
            failure = UNSET
        else:
            failure = PurchaseFailure.from_dict(_failure)

        blocked = cast(list[str], d.pop("blocked", UNSET))

        _reasons = d.pop("reasons", UNSET)
        reasons: list[PurchaseReasonsItem] | Unset = UNSET
        if _reasons is not UNSET:
            reasons = []
            for reasons_item_data in _reasons:
                reasons_item = PurchaseReasonsItem.from_dict(reasons_item_data)

                reasons.append(reasons_item)

        _checks = d.pop("checks", UNSET)
        checks: list[PurchaseChecksItem] | Unset = UNSET
        if _checks is not UNSET:
            checks = []
            for checks_item_data in _checks:
                checks_item = PurchaseChecksItem.from_dict(checks_item_data)

                checks.append(checks_item)

        _card = d.pop("card", UNSET)
        card: PurchaseCardDetail | Unset
        if isinstance(_card, Unset):
            card = UNSET
        else:
            card = PurchaseCardDetail.from_dict(_card)

        _live = d.pop("live", UNSET)
        live: PurchaseLive | Unset
        if isinstance(_live, Unset):
            live = UNSET
        else:
            live = PurchaseLive.from_dict(_live)

        purchase = cls(
            id=id,
            mandate_id=mandate_id,
            mode=mode,
            amount=amount,
            state=state,
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

        purchase.additional_properties = d
        return purchase

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
