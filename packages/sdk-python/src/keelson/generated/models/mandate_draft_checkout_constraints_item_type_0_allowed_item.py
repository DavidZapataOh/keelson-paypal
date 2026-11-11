from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_0_allowed_item_mcc_item import (
    MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem,
    check_mandate_draft_checkout_constraints_item_type_0_allowed_item_mcc_item,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType0AllowedItem")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType0AllowedItem:
    """
    Attributes:
        id (str):
        name (str):
        website (str | Unset):
        paypal_merchant_id (str | Unset):
        mcc (list[MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem] | Unset):
        country (str | Unset):
    """

    id: str
    name: str
    website: str | Unset = UNSET
    paypal_merchant_id: str | Unset = UNSET
    mcc: list[MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem] | Unset = UNSET
    country: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        name = self.name

        website = self.website

        paypal_merchant_id = self.paypal_merchant_id

        mcc: list[str] | Unset = UNSET
        if not isinstance(self.mcc, Unset):
            mcc = []
            for mcc_item_data in self.mcc:
                mcc_item: str = mcc_item_data
                mcc.append(mcc_item)

        country = self.country

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "name": name,
            }
        )
        if website is not UNSET:
            field_dict["website"] = website
        if paypal_merchant_id is not UNSET:
            field_dict["paypal_merchant_id"] = paypal_merchant_id
        if mcc is not UNSET:
            field_dict["mcc"] = mcc
        if country is not UNSET:
            field_dict["country"] = country

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        name = d.pop("name")

        website = d.pop("website", UNSET)

        paypal_merchant_id = d.pop("paypal_merchant_id", UNSET)

        _mcc = d.pop("mcc", UNSET)
        mcc: list[MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem] | Unset = UNSET
        if _mcc is not UNSET:
            mcc = []
            for mcc_item_data in _mcc:
                mcc_item = (
                    check_mandate_draft_checkout_constraints_item_type_0_allowed_item_mcc_item(
                        mcc_item_data
                    )
                )

                mcc.append(mcc_item)

        country = d.pop("country", UNSET)

        mandate_draft_checkout_constraints_item_type_0_allowed_item = cls(
            id=id,
            name=name,
            website=website,
            paypal_merchant_id=paypal_merchant_id,
            mcc=mcc,
            country=country,
        )

        return mandate_draft_checkout_constraints_item_type_0_allowed_item
