from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.live_purchase import LivePurchase


T = TypeVar("T", bound="ListLivePurchasesResponse200")


@_attrs_define
class ListLivePurchasesResponse200:
    """
    Attributes:
        purchases (list[LivePurchase]):
    """

    purchases: list[LivePurchase]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        purchases = []
        for purchases_item_data in self.purchases:
            purchases_item = purchases_item_data.to_dict()
            purchases.append(purchases_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "purchases": purchases,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.live_purchase import LivePurchase

        d = dict(src_dict)
        purchases = []
        _purchases = d.pop("purchases")
        for purchases_item_data in _purchases:
            purchases_item = LivePurchase.from_dict(purchases_item_data)

            purchases.append(purchases_item)

        list_live_purchases_response_200 = cls(
            purchases=purchases,
        )

        list_live_purchases_response_200.additional_properties = d
        return list_live_purchases_response_200

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
