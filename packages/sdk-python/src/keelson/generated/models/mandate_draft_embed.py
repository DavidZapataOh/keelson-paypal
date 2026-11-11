from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftEmbed")


@_attrs_define
class MandateDraftEmbed:
    """
    Attributes:
        top_origin (str):
    """

    top_origin: str

    def to_dict(self) -> dict[str, Any]:
        top_origin = self.top_origin

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "top_origin": top_origin,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        top_origin = d.pop("top_origin")

        mandate_draft_embed = cls(
            top_origin=top_origin,
        )

        return mandate_draft_embed
