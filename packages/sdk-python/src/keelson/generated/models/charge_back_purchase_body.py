from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.charge_back_purchase_body_reason import (
    ChargeBackPurchaseBodyReason,
    check_charge_back_purchase_body_reason,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="ChargeBackPurchaseBody")


@_attrs_define
class ChargeBackPurchaseBody:
    """
    Attributes:
        reason (ChargeBackPurchaseBodyReason):
        note (str | Unset):  Default: ''.
        amount_minor (str | Unset): Defaults to the settled amount, and cannot exceed it.
    """

    reason: ChargeBackPurchaseBodyReason
    note: str | Unset = ""
    amount_minor: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        reason: str = self.reason

        note = self.note

        amount_minor = self.amount_minor

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "reason": reason,
            }
        )
        if note is not UNSET:
            field_dict["note"] = note
        if amount_minor is not UNSET:
            field_dict["amountMinor"] = amount_minor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        reason = check_charge_back_purchase_body_reason(d.pop("reason"))

        note = d.pop("note", UNSET)

        amount_minor = d.pop("amountMinor", UNSET)

        charge_back_purchase_body = cls(
            reason=reason,
            note=note,
            amount_minor=amount_minor,
        )

        return charge_back_purchase_body
