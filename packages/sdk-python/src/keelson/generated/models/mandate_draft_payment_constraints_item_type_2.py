from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_payment_constraints_item_type_2_type import (
    MandateDraftPaymentConstraintsItemType2Type,
    check_mandate_draft_payment_constraints_item_type_2_type,
)

if TYPE_CHECKING:
    from ..models.mandate_draft_payment_constraints_item_type_2_allowed_item import (
        MandateDraftPaymentConstraintsItemType2AllowedItem,
    )


T = TypeVar("T", bound="MandateDraftPaymentConstraintsItemType2")


@_attrs_define
class MandateDraftPaymentConstraintsItemType2:
    """
    Attributes:
        type_ (MandateDraftPaymentConstraintsItemType2Type):
        allowed (list[MandateDraftPaymentConstraintsItemType2AllowedItem]):
    """

    type_: MandateDraftPaymentConstraintsItemType2Type
    allowed: list[MandateDraftPaymentConstraintsItemType2AllowedItem]

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
        from ..models.mandate_draft_payment_constraints_item_type_2_allowed_item import (
            MandateDraftPaymentConstraintsItemType2AllowedItem,
        )

        d = dict(src_dict)
        type_ = check_mandate_draft_payment_constraints_item_type_2_type(d.pop("type"))

        allowed = []
        _allowed = d.pop("allowed")
        for allowed_item_data in _allowed:
            allowed_item = MandateDraftPaymentConstraintsItemType2AllowedItem.from_dict(
                allowed_item_data
            )

            allowed.append(allowed_item)

        mandate_draft_payment_constraints_item_type_2 = cls(
            type_=type_,
            allowed=allowed,
        )

        return mandate_draft_payment_constraints_item_type_2
