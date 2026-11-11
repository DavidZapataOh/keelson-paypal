from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.mandate_summary import MandateSummary


T = TypeVar("T", bound="Mandates")


@_attrs_define
class Mandates:
    """
    Attributes:
        mandates (list[MandateSummary]):
    """

    mandates: list[MandateSummary]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandates = []
        for mandates_item_data in self.mandates:
            mandates_item = mandates_item_data.to_dict()
            mandates.append(mandates_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandates": mandates,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_summary import MandateSummary

        d = dict(src_dict)
        mandates = []
        _mandates = d.pop("mandates")
        for mandates_item_data in _mandates:
            mandates_item = MandateSummary.from_dict(mandates_item_data)

            mandates.append(mandates_item)

        mandates = cls(
            mandates=mandates,
        )

        mandates.additional_properties = d
        return mandates

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
