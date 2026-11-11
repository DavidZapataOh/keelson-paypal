from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TeeLegOnchain")


@_attrs_define
class TeeLegOnchain:
    """
    Attributes:
        chain_id (float):
        verdict_verifier (str):
        registered_at (str):
        expires_at (str):
    """

    chain_id: float
    verdict_verifier: str
    registered_at: str
    expires_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id = self.chain_id

        verdict_verifier = self.verdict_verifier

        registered_at = self.registered_at

        expires_at = self.expires_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "verdictVerifier": verdict_verifier,
                "registeredAt": registered_at,
                "expiresAt": expires_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        chain_id = d.pop("chainId")

        verdict_verifier = d.pop("verdictVerifier")

        registered_at = d.pop("registeredAt")

        expires_at = d.pop("expiresAt")

        tee_leg_onchain = cls(
            chain_id=chain_id,
            verdict_verifier=verdict_verifier,
            registered_at=registered_at,
            expires_at=expires_at,
        )

        tee_leg_onchain.additional_properties = d
        return tee_leg_onchain

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
