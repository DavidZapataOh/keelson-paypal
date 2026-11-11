from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="PendingApproval")


@_attrs_define
class PendingApproval:
    """
    Attributes:
        code (str):
        name (str):
        currency (str):
        amount_minor (str):
        over_minor (None | str): How far above the mandate the cart is; null when it is the store.
        merchant (str):
        mandate_id (str):
        expires_at (str):
    """

    code: str
    name: str
    currency: str
    amount_minor: str
    over_minor: str | None
    merchant: str
    mandate_id: str
    expires_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code

        name = self.name

        currency = self.currency

        amount_minor = self.amount_minor

        over_minor: str | None
        over_minor = self.over_minor

        merchant = self.merchant

        mandate_id = self.mandate_id

        expires_at = self.expires_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "name": name,
                "currency": currency,
                "amountMinor": amount_minor,
                "overMinor": over_minor,
                "merchant": merchant,
                "mandateId": mandate_id,
                "expiresAt": expires_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        code = d.pop("code")

        name = d.pop("name")

        currency = d.pop("currency")

        amount_minor = d.pop("amountMinor")

        def _parse_over_minor(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        over_minor = _parse_over_minor(d.pop("overMinor"))

        merchant = d.pop("merchant")

        mandate_id = d.pop("mandateId")

        expires_at = d.pop("expiresAt")

        pending_approval = cls(
            code=code,
            name=name,
            currency=currency,
            amount_minor=amount_minor,
            over_minor=over_minor,
            merchant=merchant,
            mandate_id=mandate_id,
            expires_at=expires_at,
        )

        pending_approval.additional_properties = d
        return pending_approval

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
