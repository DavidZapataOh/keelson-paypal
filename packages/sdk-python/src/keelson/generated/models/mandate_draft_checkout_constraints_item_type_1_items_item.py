from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_checkout_constraints_item_type_1_items_item_acceptable_items_item import (
        MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem,
    )


T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType1ItemsItem")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType1ItemsItem:
    """
    Attributes:
        id (str):
        acceptable_items (list[MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem]):
        quantity (int):
    """

    id: str
    acceptable_items: list[MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem]
    quantity: int

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        acceptable_items = []
        for acceptable_items_item_data in self.acceptable_items:
            acceptable_items_item = acceptable_items_item_data.to_dict()
            acceptable_items.append(acceptable_items_item)

        quantity = self.quantity

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "acceptable_items": acceptable_items,
                "quantity": quantity,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_checkout_constraints_item_type_1_items_item_acceptable_items_item import (
            MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem,
        )

        d = dict(src_dict)
        id = d.pop("id")

        acceptable_items = []
        _acceptable_items = d.pop("acceptable_items")
        for acceptable_items_item_data in _acceptable_items:
            acceptable_items_item = (
                MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem.from_dict(
                    acceptable_items_item_data
                )
            )

            acceptable_items.append(acceptable_items_item)

        quantity = d.pop("quantity")

        mandate_draft_checkout_constraints_item_type_1_items_item = cls(
            id=id,
            acceptable_items=acceptable_items,
            quantity=quantity,
        )

        return mandate_draft_checkout_constraints_item_type_1_items_item
