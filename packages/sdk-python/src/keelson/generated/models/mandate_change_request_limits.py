from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="MandateChangeRequestLimits")


@_attrs_define
class MandateChangeRequestLimits:
    """The limits asked for; the mandate's own where left out.

    Attributes:
        per_purchase_minor (int | Unset):
        total_minor (int | Unset):
        until (datetime.datetime | Unset):
        ask_above_minor (int | Unset):
    """

    per_purchase_minor: int | Unset = UNSET
    total_minor: int | Unset = UNSET
    until: datetime.datetime | Unset = UNSET
    ask_above_minor: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        per_purchase_minor = self.per_purchase_minor

        total_minor = self.total_minor

        until: str | Unset = UNSET
        if not isinstance(self.until, Unset):
            until = self.until.isoformat()

        ask_above_minor = self.ask_above_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if per_purchase_minor is not UNSET:
            field_dict["perPurchaseMinor"] = per_purchase_minor
        if total_minor is not UNSET:
            field_dict["totalMinor"] = total_minor
        if until is not UNSET:
            field_dict["until"] = until
        if ask_above_minor is not UNSET:
            field_dict["askAboveMinor"] = ask_above_minor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        per_purchase_minor = d.pop("perPurchaseMinor", UNSET)

        total_minor = d.pop("totalMinor", UNSET)

        _until = d.pop("until", UNSET)
        until: datetime.datetime | Unset
        if isinstance(_until, Unset):
            until = UNSET
        else:
            until = datetime.datetime.fromisoformat(_until)

        ask_above_minor = d.pop("askAboveMinor", UNSET)

        mandate_change_request_limits = cls(
            per_purchase_minor=per_purchase_minor,
            total_minor=total_minor,
            until=until,
            ask_above_minor=ask_above_minor,
        )

        mandate_change_request_limits.additional_properties = d
        return mandate_change_request_limits

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
