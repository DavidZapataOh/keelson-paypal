from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_0_type import (
    MandateDraftCheckoutConstraintsItemType0Type,
    check_mandate_draft_checkout_constraints_item_type_0_type,
)

if TYPE_CHECKING:
    from ..models.mandate_draft_checkout_constraints_item_type_0_allowed_item import (
        MandateDraftCheckoutConstraintsItemType0AllowedItem,
    )


T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType0")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType0:
    """
    Attributes:
        type_ (MandateDraftCheckoutConstraintsItemType0Type):
        allowed (list[MandateDraftCheckoutConstraintsItemType0AllowedItem]):
    """

    type_: MandateDraftCheckoutConstraintsItemType0Type
    allowed: list[MandateDraftCheckoutConstraintsItemType0AllowedItem]

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        allowed = []
        for allowed_item_data in self.allowed:
            allowed_item = allowed_item_data.to_dict()
            allowed.append(allowed_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "allowed": allowed,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_checkout_constraints_item_type_0_allowed_item import (
            MandateDraftCheckoutConstraintsItemType0AllowedItem,
        )

        d = dict(src_dict)
        type_ = check_mandate_draft_checkout_constraints_item_type_0_type(d.pop("type"))

        allowed = []
        _allowed = d.pop("allowed")
        for allowed_item_data in _allowed:
            allowed_item = MandateDraftCheckoutConstraintsItemType0AllowedItem.from_dict(
                allowed_item_data
            )

            allowed.append(allowed_item)

        mandate_draft_checkout_constraints_item_type_0 = cls(
            type_=type_,
            allowed=allowed,
        )

        return mandate_draft_checkout_constraints_item_type_0
