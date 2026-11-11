from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_checkout_constraints_item_type_2_allow_item import (
    MandateDraftCheckoutConstraintsItemType2AllowItem,
    check_mandate_draft_checkout_constraints_item_type_2_allow_item,
)
from ..models.mandate_draft_checkout_constraints_item_type_2_deny_item import (
    MandateDraftCheckoutConstraintsItemType2DenyItem,
    check_mandate_draft_checkout_constraints_item_type_2_deny_item,
)
from ..models.mandate_draft_checkout_constraints_item_type_2_type import (
    MandateDraftCheckoutConstraintsItemType2Type,
    check_mandate_draft_checkout_constraints_item_type_2_type,
)

T = TypeVar("T", bound="MandateDraftCheckoutConstraintsItemType2")


@_attrs_define
class MandateDraftCheckoutConstraintsItemType2:
    """
    Attributes:
        type_ (MandateDraftCheckoutConstraintsItemType2Type):
        allow (list[MandateDraftCheckoutConstraintsItemType2AllowItem]):
        deny (list[MandateDraftCheckoutConstraintsItemType2DenyItem]):
    """

    type_: MandateDraftCheckoutConstraintsItemType2Type
    allow: list[MandateDraftCheckoutConstraintsItemType2AllowItem]
    deny: list[MandateDraftCheckoutConstraintsItemType2DenyItem]

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        allow = []
        for allow_item_data in self.allow:
            allow_item: str = allow_item_data
            allow.append(allow_item)

        deny = []
        for deny_item_data in self.deny:
            deny_item: str = deny_item_data
            deny.append(deny_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "allow": allow,
                "deny": deny,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_mandate_draft_checkout_constraints_item_type_2_type(d.pop("type"))

        allow = []
        _allow = d.pop("allow")
        for allow_item_data in _allow:
            allow_item = check_mandate_draft_checkout_constraints_item_type_2_allow_item(
                allow_item_data
            )

            allow.append(allow_item)

        deny = []
        _deny = d.pop("deny")
        for deny_item_data in _deny:
            deny_item = check_mandate_draft_checkout_constraints_item_type_2_deny_item(
                deny_item_data
            )

            deny.append(deny_item)

        mandate_draft_checkout_constraints_item_type_2 = cls(
            type_=type_,
            allow=allow,
            deny=deny,
        )

        return mandate_draft_checkout_constraints_item_type_2
