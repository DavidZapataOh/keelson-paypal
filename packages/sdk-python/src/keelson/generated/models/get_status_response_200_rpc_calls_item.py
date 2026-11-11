from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="GetStatusResponse200RpcCallsItem")


@_attrs_define
class GetStatusResponse200RpcCallsItem:
    """
    Attributes:
        provider (str):
        method (str):
        calls (int):
    """

    provider: str
    method: str
    calls: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        provider = self.provider

        method = self.method

        calls = self.calls

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "provider": provider,
                "method": method,
                "calls": calls,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        provider = d.pop("provider")

        method = d.pop("method")

        calls = d.pop("calls")

        get_status_response_200_rpc_calls_item = cls(
            provider=provider,
            method=method,
            calls=calls,
        )

        get_status_response_200_rpc_calls_item.additional_properties = d
        return get_status_response_200_rpc_calls_item

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
