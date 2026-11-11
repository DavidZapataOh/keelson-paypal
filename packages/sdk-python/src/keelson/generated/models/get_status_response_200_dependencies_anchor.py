from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_anchor_environment import (
    GetStatusResponse200DependenciesAnchorEnvironment,
    check_get_status_response_200_dependencies_anchor_environment,
)
from ..models.get_status_response_200_dependencies_anchor_status import (
    GetStatusResponse200DependenciesAnchorStatus,
    check_get_status_response_200_dependencies_anchor_status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="GetStatusResponse200DependenciesAnchor")


@_attrs_define
class GetStatusResponse200DependenciesAnchor:
    """
    Attributes:
        status (GetStatusResponse200DependenciesAnchorStatus):
        environment (GetStatusResponse200DependenciesAnchorEnvironment):
        size (str | Unset):
        anchored_age_ms (int | Unset):
    """

    status: GetStatusResponse200DependenciesAnchorStatus
    environment: GetStatusResponse200DependenciesAnchorEnvironment
    size: str | Unset = UNSET
    anchored_age_ms: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        environment: str = self.environment

        size = self.size

        anchored_age_ms = self.anchored_age_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "environment": environment,
            }
        )
        if size is not UNSET:
            field_dict["size"] = size
        if anchored_age_ms is not UNSET:
            field_dict["anchoredAgeMs"] = anchored_age_ms

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_anchor_status(d.pop("status"))

        environment = check_get_status_response_200_dependencies_anchor_environment(
            d.pop("environment")
        )

        size = d.pop("size", UNSET)

        anchored_age_ms = d.pop("anchoredAgeMs", UNSET)

        get_status_response_200_dependencies_anchor = cls(
            status=status,
            environment=environment,
            size=size,
            anchored_age_ms=anchored_age_ms,
        )

        get_status_response_200_dependencies_anchor.additional_properties = d
        return get_status_response_200_dependencies_anchor

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
