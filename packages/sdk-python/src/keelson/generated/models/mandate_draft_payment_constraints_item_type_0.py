from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_payment_constraints_item_type_0_currency import (
    MandateDraftPaymentConstraintsItemType0Currency,
    check_mandate_draft_payment_constraints_item_type_0_currency,
)
from ..models.mandate_draft_payment_constraints_item_type_0_type import (
    MandateDraftPaymentConstraintsItemType0Type,
    check_mandate_draft_payment_constraints_item_type_0_type,
)

T = TypeVar("T", bound="MandateDraftPaymentConstraintsItemType0")


@_attrs_define
class MandateDraftPaymentConstraintsItemType0:
    """
    Attributes:
        type_ (MandateDraftPaymentConstraintsItemType0Type):
        max_ (int):
        currency (MandateDraftPaymentConstraintsItemType0Currency):
    """

    type_: MandateDraftPaymentConstraintsItemType0Type
    max_: int
    currency: MandateDraftPaymentConstraintsItemType0Currency

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        max_ = self.max_

        currency: str = self.currency

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "max": max_,
                "currency": currency,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_mandate_draft_payment_constraints_item_type_0_type(d.pop("type"))

        max_ = d.pop("max")

        currency = check_mandate_draft_payment_constraints_item_type_0_currency(d.pop("currency"))

        mandate_draft_payment_constraints_item_type_0 = cls(
            type_=type_,
            max_=max_,
            currency=currency,
        )

        return mandate_draft_payment_constraints_item_type_0
