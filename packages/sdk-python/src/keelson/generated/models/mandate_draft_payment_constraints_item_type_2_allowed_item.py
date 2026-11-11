from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftPaymentConstraintsItemType2AllowedItem")


@_attrs_define
class MandateDraftPaymentConstraintsItemType2AllowedItem:
    """
    Attributes:
        paypal_merchant_id (str):
    """

    paypal_merchant_id: str

    def to_dict(self) -> dict[str, Any]:
        paypal_merchant_id = self.paypal_merchant_id

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "paypal_merchant_id": paypal_merchant_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        paypal_merchant_id = d.pop("paypal_merchant_id")

        mandate_draft_payment_constraints_item_type_2_allowed_item = cls(
            paypal_merchant_id=paypal_merchant_id,
        )

        return mandate_draft_payment_constraints_item_type_2_allowed_item
