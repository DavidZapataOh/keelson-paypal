from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftConsent")


@_attrs_define
class MandateDraftConsent:
    """
    Attributes:
        terms_hash (str):
        instruction_use (bool):
        responsibility_ack (bool):
        merchant_policy_ack (str):
        recurrence_ack (bool):
    """

    terms_hash: str
    instruction_use: bool
    responsibility_ack: bool
    merchant_policy_ack: str
    recurrence_ack: bool

    def to_dict(self) -> dict[str, Any]:
        terms_hash = self.terms_hash

        instruction_use = self.instruction_use

        responsibility_ack = self.responsibility_ack

        merchant_policy_ack = self.merchant_policy_ack

        recurrence_ack = self.recurrence_ack

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "terms_hash": terms_hash,
                "instruction_use": instruction_use,
                "responsibility_ack": responsibility_ack,
                "merchant_policy_ack": merchant_policy_ack,
                "recurrence_ack": recurrence_ack,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        terms_hash = d.pop("terms_hash")

        instruction_use = d.pop("instruction_use")

        responsibility_ack = d.pop("responsibility_ack")

        merchant_policy_ack = d.pop("merchant_policy_ack")

        recurrence_ack = d.pop("recurrence_ack")

        mandate_draft_consent = cls(
            terms_hash=terms_hash,
            instruction_use=instruction_use,
            responsibility_ack=responsibility_ack,
            merchant_policy_ack=merchant_policy_ack,
            recurrence_ack=recurrence_ack,
        )

        return mandate_draft_consent
