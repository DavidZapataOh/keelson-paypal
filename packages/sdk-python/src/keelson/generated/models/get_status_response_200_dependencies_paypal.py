from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_paypal_environment import (
    GetStatusResponse200DependenciesPaypalEnvironment,
    check_get_status_response_200_dependencies_paypal_environment,
)
from ..models.get_status_response_200_dependencies_paypal_status import (
    GetStatusResponse200DependenciesPaypalStatus,
    check_get_status_response_200_dependencies_paypal_status,
)

T = TypeVar("T", bound="GetStatusResponse200DependenciesPaypal")


@_attrs_define
class GetStatusResponse200DependenciesPaypal:
    """
    Attributes:
        status (GetStatusResponse200DependenciesPaypalStatus):
        environment (GetStatusResponse200DependenciesPaypalEnvironment):
    """

    status: GetStatusResponse200DependenciesPaypalStatus
    environment: GetStatusResponse200DependenciesPaypalEnvironment
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        environment: str = self.environment

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "environment": environment,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_paypal_status(d.pop("status"))

        environment = check_get_status_response_200_dependencies_paypal_environment(
            d.pop("environment")
        )

        get_status_response_200_dependencies_paypal = cls(
            status=status,
            environment=environment,
        )

        get_status_response_200_dependencies_paypal.additional_properties = d
        return get_status_response_200_dependencies_paypal

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
