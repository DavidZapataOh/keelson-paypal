from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="GetStatusResponse200DependenciesLogOriginsItem")


@_attrs_define
class GetStatusResponse200DependenciesLogOriginsItem:
    """
    Attributes:
        origin (str):
        size (int):
        checkpoint_age_ms (int):
    """

    origin: str
    size: int
    checkpoint_age_ms: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        origin = self.origin

        size = self.size

        checkpoint_age_ms = self.checkpoint_age_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "origin": origin,
                "size": size,
                "checkpointAgeMs": checkpoint_age_ms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        origin = d.pop("origin")

        size = d.pop("size")

        checkpoint_age_ms = d.pop("checkpointAgeMs")

        get_status_response_200_dependencies_log_origins_item = cls(
            origin=origin,
            size=size,
            checkpoint_age_ms=checkpoint_age_ms,
        )

        get_status_response_200_dependencies_log_origins_item.additional_properties = d
        return get_status_response_200_dependencies_log_origins_item

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
