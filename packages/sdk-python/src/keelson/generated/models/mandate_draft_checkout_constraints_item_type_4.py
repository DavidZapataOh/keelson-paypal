from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_4_type import (
    MandateDraftCheckoutConstraintsItemType4Type,
    check_mandate_draft_checkout_constraints_item_type_4_type,
)

T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType4")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType4:
    """
    Attributes:
        type_ (MandateDraftCheckoutConstraintsItemType4Type):
        min_days (int):
        free (bool):
    """

    type_: MandateDraftCheckoutConstraintsItemType4Type
    min_days: int
    free: bool

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        min_days = self.min_days

        free = self.free

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "min_days": min_days,
                "free": free,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_mandate_draft_checkout_constraints_item_type_4_type(d.pop("type"))

        min_days = d.pop("min_days")

        free = d.pop("free")

        mandate_draft_checkout_constraints_item_type_4 = cls(
            type_=type_,
            min_days=min_days,
            free=free,
        )

        return mandate_draft_checkout_constraints_item_type_4
