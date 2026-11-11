from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ConnectionParent")


@_attrs_define
class ConnectionParent:
    """
    Attributes:
        mandate_id (str):
        per_purchase_minor (str):
        total_minor (str):
        remaining_minor (str):
        until (str):
    """

    mandate_id: str
    per_purchase_minor: str
    total_minor: str
    remaining_minor: str
    until: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_id = self.mandate_id

        per_purchase_minor = self.per_purchase_minor

        total_minor = self.total_minor

        remaining_minor = self.remaining_minor

        until = self.until

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandateId": mandate_id,
                "perPurchaseMinor": per_purchase_minor,
                "totalMinor": total_minor,
                "remainingMinor": remaining_minor,
                "until": until,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        mandate_id = d.pop("mandateId")

        per_purchase_minor = d.pop("perPurchaseMinor")

        total_minor = d.pop("totalMinor")

        remaining_minor = d.pop("remainingMinor")

        until = d.pop("until")

        connection_parent = cls(
            mandate_id=mandate_id,
            per_purchase_minor=per_purchase_minor,
            total_minor=total_minor,
            remaining_minor=remaining_minor,
            until=until,
        )

        connection_parent.additional_properties = d
        return connection_parent

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
