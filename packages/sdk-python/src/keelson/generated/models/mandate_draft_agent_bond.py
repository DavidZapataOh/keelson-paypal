from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftAgentBond")


@_attrs_define
class MandateDraftAgentBond:
    """
    Attributes:
        vault (str):
        asset (str):
        min_ (int):
    """

    vault: str
    asset: str
    min_: int

    def to_dict(self) -> dict[str, Any]:
        vault = self.vault

        asset = self.asset

        min_ = self.min_

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "vault": vault,
                "asset": asset,
                "min": min_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        vault = d.pop("vault")

        asset = d.pop("asset")

        min_ = d.pop("min")

        mandate_draft_agent_bond = cls(
            vault=vault,
            asset=asset,
            min_=min_,
        )

        return mandate_draft_agent_bond
