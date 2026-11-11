from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.draft_embed_mandate_response_200_check_status import (
    DraftEmbedMandateResponse200CheckStatus,
    check_draft_embed_mandate_response_200_check_status,
)

T = TypeVar("T", bound="DraftEmbedMandateResponse200Check")


@_attrs_define
class DraftEmbedMandateResponse200Check:
    """
    Attributes:
        status (DraftEmbedMandateResponse200CheckStatus):
        discrepancies (None):
    """

    status: DraftEmbedMandateResponse200CheckStatus
    discrepancies: None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        discrepancies = self.discrepancies

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "discrepancies": discrepancies,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = check_draft_embed_mandate_response_200_check_status(d.pop("status"))

        discrepancies = d.pop("discrepancies")

        draft_embed_mandate_response_200_check = cls(
            status=status,
            discrepancies=discrepancies,
        )

        draft_embed_mandate_response_200_check.additional_properties = d
        return draft_embed_mandate_response_200_check

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
