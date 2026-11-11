from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.get_status_response_200_rpc_calls_item import GetStatusResponse200RpcCallsItem


T = TypeVar("T", bound="GetStatusResponse200Rpc")


@_attrs_define
class GetStatusResponse200Rpc:
    """
    Attributes:
        calls (list[GetStatusResponse200RpcCallsItem]):
    """

    calls: list[GetStatusResponse200RpcCallsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        calls = []
        for calls_item_data in self.calls:
            calls_item = calls_item_data.to_dict()
            calls.append(calls_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "calls": calls,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_status_response_200_rpc_calls_item import GetStatusResponse200RpcCallsItem

        d = dict(src_dict)
        calls = []
        _calls = d.pop("calls")
        for calls_item_data in _calls:
            calls_item = GetStatusResponse200RpcCallsItem.from_dict(calls_item_data)

            calls.append(calls_item)

        get_status_response_200_rpc = cls(
            calls=calls,
        )

        get_status_response_200_rpc.additional_properties = d
        return get_status_response_200_rpc

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
