from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="PurchaseLive")


@_attrs_define
class PurchaseLive:
    """A purchase the buyer pays at the store's own checkout: the store's origin and the PayPal transaction id once the
    agent recorded it. Never covered nor captured.

        Attributes:
            store (str):
            transaction_id (None | str):
    """

    store: str
    transaction_id: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        store = self.store

        transaction_id: str | None
        transaction_id = self.transaction_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "store": store,
                "transactionId": transaction_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        store = d.pop("store")

        def _parse_transaction_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        transaction_id = _parse_transaction_id(d.pop("transactionId"))

        purchase_live = cls(
            store=store,
            transaction_id=transaction_id,
        )

        purchase_live.additional_properties = d
        return purchase_live

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
