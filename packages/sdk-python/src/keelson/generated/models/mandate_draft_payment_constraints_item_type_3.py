from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_payment_constraints_item_type_3_type import (
    MandateDraftPaymentConstraintsItemType3Type,
    check_mandate_draft_payment_constraints_item_type_3_type,
)

T = TypeVar("T", bound="MandateDraftPaymentConstraintsItemType3")


@_attrs_define
class MandateDraftPaymentConstraintsItemType3:
    """
    Attributes:
        type_ (MandateDraftPaymentConstraintsItemType3Type):
        not_after (datetime.datetime):
    """

    type_: MandateDraftPaymentConstraintsItemType3Type
    not_after: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        not_after = self.not_after.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "not_after": not_after,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_mandate_draft_payment_constraints_item_type_3_type(d.pop("type"))

        not_after = datetime.datetime.fromisoformat(d.pop("not_after"))

        mandate_draft_payment_constraints_item_type_3 = cls(
            type_=type_,
            not_after=not_after,
        )

        return mandate_draft_payment_constraints_item_type_3
