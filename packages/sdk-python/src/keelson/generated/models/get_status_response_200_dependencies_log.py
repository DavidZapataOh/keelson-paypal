from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_log_status import (
    GetStatusResponse200DependenciesLogStatus,
    check_get_status_response_200_dependencies_log_status,
)

if TYPE_CHECKING:
    from ..models.get_status_response_200_dependencies_log_origins_item import (
        GetStatusResponse200DependenciesLogOriginsItem,
    )


T = TypeVar("T", bound="GetStatusResponse200DependenciesLog")


@_attrs_define
class GetStatusResponse200DependenciesLog:
    """
    Attributes:
        status (GetStatusResponse200DependenciesLogStatus):
        origins (list[GetStatusResponse200DependenciesLogOriginsItem]):
    """

    status: GetStatusResponse200DependenciesLogStatus
    origins: list[GetStatusResponse200DependenciesLogOriginsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        origins = []
        for origins_item_data in self.origins:
            origins_item = origins_item_data.to_dict()
            origins.append(origins_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "origins": origins,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_status_response_200_dependencies_log_origins_item import (
            GetStatusResponse200DependenciesLogOriginsItem,
        )

        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_log_status(d.pop("status"))

        origins = []
        _origins = d.pop("origins")
        for origins_item_data in _origins:
            origins_item = GetStatusResponse200DependenciesLogOriginsItem.from_dict(
                origins_item_data
            )

            origins.append(origins_item)

        get_status_response_200_dependencies_log = cls(
            status=status,
            origins=origins,
        )

        get_status_response_200_dependencies_log.additional_properties = d
        return get_status_response_200_dependencies_log

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
