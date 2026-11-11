from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_payment_constraints_item_type_4_mcc_table import (
    MandateDraftPaymentConstraintsItemType4MccTable,
    check_mandate_draft_payment_constraints_item_type_4_mcc_table,
)
from ..models.mandate_draft_payment_constraints_item_type_4_type import (
    MandateDraftPaymentConstraintsItemType4Type,
    check_mandate_draft_payment_constraints_item_type_4_type,
)

T = TypeVar("T", bound="MandateDraftPaymentConstraintsItemType4")


@_attrs_define
class MandateDraftPaymentConstraintsItemType4:
    """
    Attributes:
        type_ (MandateDraftPaymentConstraintsItemType4Type):
        single_use (bool):
        mcc_table (MandateDraftPaymentConstraintsItemType4MccTable):
    """

    type_: MandateDraftPaymentConstraintsItemType4Type
    single_use: bool
    mcc_table: MandateDraftPaymentConstraintsItemType4MccTable

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        single_use = self.single_use

        mcc_table: str = self.mcc_table

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "single_use": single_use,
                "mcc_table": mcc_table,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_mandate_draft_payment_constraints_item_type_4_type(d.pop("type"))

        single_use = d.pop("single_use")

        mcc_table = check_mandate_draft_payment_constraints_item_type_4_mcc_table(
            d.pop("mcc_table")
        )

        mandate_draft_payment_constraints_item_type_4 = cls(
            type_=type_,
            single_use=single_use,
            mcc_table=mcc_table,
        )

        return mandate_draft_payment_constraints_item_type_4
