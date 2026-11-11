from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.connection_approved_kind import ConnectionApprovedKind, check_connection_approved_kind

T = TypeVar("T", bound="ConnectionApproved")


@_attrs_define
class ConnectionApproved:
    """
    Attributes:
        mandate_id (str):
        kind (ConnectionApprovedKind):
    """

    mandate_id: str
    kind: ConnectionApprovedKind
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_id = self.mandate_id

        kind: str = self.kind

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandate_id": mandate_id,
                "kind": kind,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        mandate_id = d.pop("mandate_id")

        kind = check_connection_approved_kind(d.pop("kind"))

        connection_approved = cls(
            mandate_id=mandate_id,
            kind=kind,
        )

        connection_approved.additional_properties = d
        return connection_approved

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
