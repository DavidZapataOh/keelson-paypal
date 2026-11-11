from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.judge_tour_mandate_budget import JudgeTourMandateBudget
    from ..models.judge_tour_mandate_card import JudgeTourMandateCard
    from ..models.judge_tour_purchase import JudgeTourPurchase


T = TypeVar("T", bound="JudgeTourMandate")


@_attrs_define
class JudgeTourMandate:
    """
    Attributes:
        id (str):
        state (str):
        mandate_hash (None | str):
        budget (JudgeTourMandateBudget):
        created_at (datetime.datetime):
        card (JudgeTourMandateCard):
        purchases (list[JudgeTourPurchase]):
    """

    id: str
    state: str
    mandate_hash: str | None
    budget: JudgeTourMandateBudget
    created_at: datetime.datetime
    card: JudgeTourMandateCard
    purchases: list[JudgeTourPurchase]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        state = self.state

        mandate_hash: str | None
        mandate_hash = self.mandate_hash

        budget = self.budget.to_dict()

        created_at = self.created_at.isoformat()

        card = self.card.to_dict()

        purchases = []
        for purchases_item_data in self.purchases:
            purchases_item = purchases_item_data.to_dict()
            purchases.append(purchases_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "mandate_hash": mandate_hash,
                "budget": budget,
                "created_at": created_at,
                "card": card,
                "purchases": purchases,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.judge_tour_mandate_budget import JudgeTourMandateBudget
        from ..models.judge_tour_mandate_card import JudgeTourMandateCard
        from ..models.judge_tour_purchase import JudgeTourPurchase

        d = dict(src_dict)
        id = d.pop("id")

        state = d.pop("state")

        def _parse_mandate_hash(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate_hash = _parse_mandate_hash(d.pop("mandate_hash"))

        budget = JudgeTourMandateBudget.from_dict(d.pop("budget"))

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        card = JudgeTourMandateCard.from_dict(d.pop("card"))

        purchases = []
        _purchases = d.pop("purchases")
        for purchases_item_data in _purchases:
            purchases_item = JudgeTourPurchase.from_dict(purchases_item_data)

            purchases.append(purchases_item)

        judge_tour_mandate = cls(
            id=id,
            state=state,
            mandate_hash=mandate_hash,
            budget=budget,
            created_at=created_at,
            card=card,
            purchases=purchases,
        )

        judge_tour_mandate.additional_properties = d
        return judge_tour_mandate

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
