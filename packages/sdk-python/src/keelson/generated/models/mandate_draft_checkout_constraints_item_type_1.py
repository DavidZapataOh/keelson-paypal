from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_1_type import (
    MandateDraftCheckoutConstraintsItemType1Type,
    check_mandate_draft_checkout_constraints_item_type_1_type,
)

if TYPE_CHECKING:
    from ..models.mandate_draft_checkout_constraints_item_type_1_items_item import (
        MandateDraftCheckoutConstraintsItemType1ItemsItem,
    )


T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType1")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType1:
    """
    Attributes:
        type_ (MandateDraftCheckoutConstraintsItemType1Type):
        items (list[MandateDraftCheckoutConstraintsItemType1ItemsItem]):
    """

    type_: MandateDraftCheckoutConstraintsItemType1Type
    items: list[MandateDraftCheckoutConstraintsItemType1ItemsItem]

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "items": items,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_checkout_constraints_item_type_1_items_item import (
            MandateDraftCheckoutConstraintsItemType1ItemsItem,
        )

        d = dict(src_dict)
        type_ = check_mandate_draft_checkout_constraints_item_type_1_type(d.pop("type"))

        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = MandateDraftCheckoutConstraintsItemType1ItemsItem.from_dict(
                items_item_data
            )

            items.append(items_item)

        mandate_draft_checkout_constraints_item_type_1 = cls(
            type_=type_,
            items=items,
        )

        return mandate_draft_checkout_constraints_item_type_1
