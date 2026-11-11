from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LogBondWithdrawal")


@_attrs_define
class LogBondWithdrawal:
    """
    Attributes:
        amount_minor (str):
        unlock_at (str):
        to (str):
    """

    amount_minor: str
    unlock_at: str
    to: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        amount_minor = self.amount_minor

        unlock_at = self.unlock_at

        to = self.to

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "amountMinor": amount_minor,
                "unlockAt": unlock_at,
                "to": to,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        amount_minor = d.pop("amountMinor")

        unlock_at = d.pop("unlockAt")

        to = d.pop("to")

        log_bond_withdrawal = cls(
            amount_minor=amount_minor,
            unlock_at=unlock_at,
            to=to,
        )

        log_bond_withdrawal.additional_properties = d
        return log_bond_withdrawal

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
