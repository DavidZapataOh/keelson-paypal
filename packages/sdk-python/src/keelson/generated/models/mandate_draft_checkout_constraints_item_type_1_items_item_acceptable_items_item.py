from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType1ItemsItemAcceptableItemsItem:
    """
    Attributes:
        id (str):
        title (str | Unset):
    """

    id: str
    title: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        title = self.title

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
            }
        )
        if title is not UNSET:
            field_dict["title"] = title

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        title = d.pop("title", UNSET)

        mandate_draft_checkout_constraints_item_type_1_items_item_acceptable_items_item = cls(
            id=id,
            title=title,
        )

        return mandate_draft_checkout_constraints_item_type_1_items_item_acceptable_items_item
