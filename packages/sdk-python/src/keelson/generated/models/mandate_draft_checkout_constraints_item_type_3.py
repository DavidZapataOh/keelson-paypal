from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_3_type import (
    MandateDraftCheckoutConstraintsItemType3Type,
    check_mandate_draft_checkout_constraints_item_type_3_type,
)

if TYPE_CHECKING:
    from ..models.mandate_draft_checkout_constraints_item_type_3_must import (
        MandateDraftCheckoutConstraintsItemType3Must,
    )


T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType3")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType3:
    """
    Attributes:
        type_ (MandateDraftCheckoutConstraintsItemType3Type):
        must (MandateDraftCheckoutConstraintsItemType3Must):
    """

    type_: MandateDraftCheckoutConstraintsItemType3Type
    must: MandateDraftCheckoutConstraintsItemType3Must

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        must = self.must.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "must": must,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_checkout_constraints_item_type_3_must import (
            MandateDraftCheckoutConstraintsItemType3Must,
        )

        d = dict(src_dict)
        type_ = check_mandate_draft_checkout_constraints_item_type_3_type(d.pop("type"))

        must = MandateDraftCheckoutConstraintsItemType3Must.from_dict(d.pop("must"))

        mandate_draft_checkout_constraints_item_type_3 = cls(
            type_=type_,
            must=must,
        )

        return mandate_draft_checkout_constraints_item_type_3
