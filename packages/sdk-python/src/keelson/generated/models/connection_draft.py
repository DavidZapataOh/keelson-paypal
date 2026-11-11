from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.connection_draft_limits import ConnectionDraftLimits


T = TypeVar("T", bound="ConnectionDraft")


@_attrs_define
class ConnectionDraft:
    """
    Attributes:
        limits (ConnectionDraftLimits):
        credential_id (str | Unset):
    """

    limits: ConnectionDraftLimits
    credential_id: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        limits = self.limits.to_dict()

        credential_id = self.credential_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "limits": limits,
            }
        )
        if credential_id is not UNSET:
            field_dict["credentialId"] = credential_id

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_draft_limits import ConnectionDraftLimits

        d = dict(src_dict)
        limits = ConnectionDraftLimits.from_dict(d.pop("limits"))

        credential_id = d.pop("credentialId", UNSET)

        connection_draft = cls(
            limits=limits,
            credential_id=credential_id,
        )

        connection_draft.additional_properties = d
        return connection_draft

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
