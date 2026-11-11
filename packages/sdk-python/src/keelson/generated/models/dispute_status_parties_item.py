from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.dispute_status_parties_item_party import (
    DisputeStatusPartiesItemParty,
    check_dispute_status_parties_item_party,
)

T = TypeVar("T", bound="DisputeStatusPartiesItem")


@_attrs_define
class DisputeStatusPartiesItem:
    """
    Attributes:
        party (DisputeStatusPartiesItemParty):
        liable (bool):
    """

    party: DisputeStatusPartiesItemParty
    liable: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        party: str = self.party

        liable = self.liable

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "party": party,
                "liable": liable,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        party = check_dispute_status_parties_item_party(d.pop("party"))

        liable = d.pop("liable")

        dispute_status_parties_item = cls(
            party=party,
            liable=liable,
        )

        dispute_status_parties_item.additional_properties = d
        return dispute_status_parties_item

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
