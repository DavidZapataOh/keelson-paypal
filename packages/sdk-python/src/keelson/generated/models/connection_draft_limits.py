from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="ConnectionDraftLimits")


@_attrs_define
class ConnectionDraftLimits:
    """
    Attributes:
        per_purchase_minor (int):
        total_minor (int):
        merchants (list[str]):
        until (datetime.datetime):
        ask_above_minor (int | Unset):
    """

    per_purchase_minor: int
    total_minor: int
    merchants: list[str]
    until: datetime.datetime
    ask_above_minor: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        per_purchase_minor = self.per_purchase_minor

        total_minor = self.total_minor

        merchants = self.merchants

        until = self.until.isoformat()

        ask_above_minor = self.ask_above_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "perPurchaseMinor": per_purchase_minor,
                "totalMinor": total_minor,
                "merchants": merchants,
                "until": until,
            }
        )
        if ask_above_minor is not UNSET:
            field_dict["askAboveMinor"] = ask_above_minor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        per_purchase_minor = d.pop("perPurchaseMinor")

        total_minor = d.pop("totalMinor")

        merchants = cast(list[str], d.pop("merchants"))

        until = datetime.datetime.fromisoformat(d.pop("until"))

        ask_above_minor = d.pop("askAboveMinor", UNSET)

        connection_draft_limits = cls(
            per_purchase_minor=per_purchase_minor,
            total_minor=total_minor,
            merchants=merchants,
            until=until,
            ask_above_minor=ask_above_minor,
        )

        connection_draft_limits.additional_properties = d
        return connection_draft_limits

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
