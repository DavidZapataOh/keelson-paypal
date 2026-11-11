from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.judge_tour_purchase_amount import JudgeTourPurchaseAmount
    from ..models.judge_tour_purchase_checks_item import JudgeTourPurchaseChecksItem


T = TypeVar("T", bound="JudgeTourPurchase")


@_attrs_define
class JudgeTourPurchase:
    """
    Attributes:
        id (str): The purchase's ULID, which is also its Alibi id.
        state (str):
        mode (None | str):
        amount (JudgeTourPurchaseAmount):
        merchant_id (str):
        created_at (datetime.datetime):
        log_index (None | str):
        capture_id (None | str):
        coverage_tx (None | str):
        failure (None | str):
        checks (list[JudgeTourPurchaseChecksItem]): Each mandate field the engine checked.
        alibi_fragment (None | str): `<leaf hash>.<anchored size>.<chain id>`: the fragment of the Alibi's verifier
            link, `https://verify.keelson.finance/a/<id>#<fragment>`.
    """

    id: str
    state: str
    mode: str | None
    amount: JudgeTourPurchaseAmount
    merchant_id: str
    created_at: datetime.datetime
    log_index: str | None
    capture_id: str | None
    coverage_tx: str | None
    failure: str | None
    checks: list[JudgeTourPurchaseChecksItem]
    alibi_fragment: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        state = self.state

        mode: str | None
        mode = self.mode

        amount = self.amount.to_dict()

        merchant_id = self.merchant_id

        created_at = self.created_at.isoformat()

        log_index: str | None
        log_index = self.log_index

        capture_id: str | None
        capture_id = self.capture_id

        coverage_tx: str | None
        coverage_tx = self.coverage_tx

        failure: str | None
        failure = self.failure

        checks = []
        for checks_item_data in self.checks:
            checks_item = checks_item_data.to_dict()
            checks.append(checks_item)

        alibi_fragment: str | None
        alibi_fragment = self.alibi_fragment

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "mode": mode,
                "amount": amount,
                "merchant_id": merchant_id,
                "created_at": created_at,
                "log_index": log_index,
                "capture_id": capture_id,
                "coverage_tx": coverage_tx,
                "failure": failure,
                "checks": checks,
                "alibi_fragment": alibi_fragment,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.judge_tour_purchase_amount import JudgeTourPurchaseAmount
        from ..models.judge_tour_purchase_checks_item import JudgeTourPurchaseChecksItem

        d = dict(src_dict)
        id = d.pop("id")

        state = d.pop("state")

        def _parse_mode(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mode = _parse_mode(d.pop("mode"))

        amount = JudgeTourPurchaseAmount.from_dict(d.pop("amount"))

        merchant_id = d.pop("merchant_id")

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        def _parse_log_index(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        log_index = _parse_log_index(d.pop("log_index"))

        def _parse_capture_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        capture_id = _parse_capture_id(d.pop("capture_id"))

        def _parse_coverage_tx(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        coverage_tx = _parse_coverage_tx(d.pop("coverage_tx"))

        def _parse_failure(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        failure = _parse_failure(d.pop("failure"))

        checks = []
        _checks = d.pop("checks")
        for checks_item_data in _checks:
            checks_item = JudgeTourPurchaseChecksItem.from_dict(checks_item_data)

            checks.append(checks_item)

        def _parse_alibi_fragment(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        alibi_fragment = _parse_alibi_fragment(d.pop("alibi_fragment"))

        judge_tour_purchase = cls(
            id=id,
            state=state,
            mode=mode,
            amount=amount,
            merchant_id=merchant_id,
            created_at=created_at,
            log_index=log_index,
            capture_id=capture_id,
            coverage_tx=coverage_tx,
            failure=failure,
            checks=checks,
            alibi_fragment=alibi_fragment,
        )

        judge_tour_purchase.additional_properties = d
        return judge_tour_purchase

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
