from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_status import (
    GetStatusResponse200Status,
    check_get_status_response_200_status,
)

if TYPE_CHECKING:
    from ..models.get_status_response_200_dependencies import GetStatusResponse200Dependencies
    from ..models.get_status_response_200_rpc import GetStatusResponse200Rpc


T = TypeVar("T", bound="GetStatusResponse200")


@_attrs_define
class GetStatusResponse200:
    """
    Attributes:
        status (GetStatusResponse200Status):
        dependencies (GetStatusResponse200Dependencies):
        rpc (GetStatusResponse200Rpc):
        version (str):
    """

    status: GetStatusResponse200Status
    dependencies: GetStatusResponse200Dependencies
    rpc: GetStatusResponse200Rpc
    version: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        dependencies = self.dependencies.to_dict()

        rpc = self.rpc.to_dict()

        version = self.version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "dependencies": dependencies,
                "rpc": rpc,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_status_response_200_dependencies import GetStatusResponse200Dependencies
        from ..models.get_status_response_200_rpc import GetStatusResponse200Rpc

        d = dict(src_dict)
        status = check_get_status_response_200_status(d.pop("status"))

        dependencies = GetStatusResponse200Dependencies.from_dict(d.pop("dependencies"))

        rpc = GetStatusResponse200Rpc.from_dict(d.pop("rpc"))

        version = d.pop("version")

        get_status_response_200 = cls(
            status=status,
            dependencies=dependencies,
            rpc=rpc,
            version=version,
        )

        get_status_response_200.additional_properties = d
        return get_status_response_200

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
