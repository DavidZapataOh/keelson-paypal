from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="AgentMandate")


@_attrs_define
class AgentMandate:
    """
    Attributes:
        id (str):
        state (str):
        currency (str):
        max_minor (str):
        remaining_minor (str):
        expires_at (str):
        merchants (list[str]):
    """

    id: str
    state: str
    currency: str
    max_minor: str
    remaining_minor: str
    expires_at: str
    merchants: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        state = self.state

        currency = self.currency

        max_minor = self.max_minor

        remaining_minor = self.remaining_minor

        expires_at = self.expires_at

        merchants = self.merchants

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "currency": currency,
                "maxMinor": max_minor,
                "remainingMinor": remaining_minor,
                "expiresAt": expires_at,
                "merchants": merchants,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        state = d.pop("state")

        currency = d.pop("currency")

        max_minor = d.pop("maxMinor")

        remaining_minor = d.pop("remainingMinor")

        expires_at = d.pop("expiresAt")

        merchants = cast(list[str], d.pop("merchants"))

        agent_mandate = cls(
            id=id,
            state=state,
            currency=currency,
            max_minor=max_minor,
            remaining_minor=remaining_minor,
            expires_at=expires_at,
            merchants=merchants,
        )

        agent_mandate.additional_properties = d
        return agent_mandate

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
