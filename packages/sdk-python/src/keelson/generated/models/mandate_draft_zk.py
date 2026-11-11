from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftZk")


@_attrs_define
class MandateDraftZk:
    """
    Attributes:
        commitment (str):
    """

    commitment: str

    def to_dict(self) -> dict[str, Any]:
        commitment = self.commitment

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "commitment": commitment,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        commitment = d.pop("commitment")

        mandate_draft_zk = cls(
            commitment=commitment,
        )

        return mandate_draft_zk
