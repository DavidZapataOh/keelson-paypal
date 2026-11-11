from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.connection_limits import ConnectionLimits


T = TypeVar("T", bound="ConnectionRequest")


@_attrs_define
class ConnectionRequest:
    """
    Attributes:
        name (str):  Example: Claude Code.
        reason (str): Why the agent asks, in its own words; the user reads it before approving.
        limits (ConnectionLimits):
    """

    name: str
    reason: str
    limits: ConnectionLimits
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        reason = self.reason

        limits = self.limits.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "name": name,
                "reason": reason,
                "limits": limits,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_limits import ConnectionLimits

        d = dict(src_dict)
        name = d.pop("name")

        reason = d.pop("reason")

        limits = ConnectionLimits.from_dict(d.pop("limits"))

        connection_request = cls(
            name=name,
            reason=reason,
            limits=limits,
        )

        connection_request.additional_properties = d
        return connection_request

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
