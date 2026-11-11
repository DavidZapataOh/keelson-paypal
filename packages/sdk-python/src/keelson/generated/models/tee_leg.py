from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.tee_leg_tee import TeeLegTee, check_tee_leg_tee

if TYPE_CHECKING:
    from ..models.tee_leg_attestation import TeeLegAttestation
    from ..models.tee_leg_onchain import TeeLegOnchain


T = TypeVar("T", bound="TeeLeg")


@_attrs_define
class TeeLeg:
    """
    Attributes:
        tee (TeeLegTee):
        signer (str):
        measurement (str):
        registered_at (str):
        verified_at (str): When the attestation last verified.
        expires_at (str):
        onchain (None | TeeLegOnchain): The signer's record in the VerdictVerifier, which on-chain verification reads;
            null when it is not registered there.
        attestation (TeeLegAttestation): The attestation the signer was admitted from: the platform evidence, its
            binding and the block it was made over.
    """

    tee: TeeLegTee
    signer: str
    measurement: str
    registered_at: str
    verified_at: str
    expires_at: str
    onchain: TeeLegOnchain | None
    attestation: TeeLegAttestation
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.tee_leg_onchain import TeeLegOnchain

        tee: str = self.tee

        signer = self.signer

        measurement = self.measurement

        registered_at = self.registered_at

        verified_at = self.verified_at

        expires_at = self.expires_at

        onchain: dict[str, Any] | None
        if isinstance(self.onchain, TeeLegOnchain):
            onchain = self.onchain.to_dict()
        else:
            onchain = self.onchain

        attestation = self.attestation.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "tee": tee,
                "signer": signer,
                "measurement": measurement,
                "registeredAt": registered_at,
                "verifiedAt": verified_at,
                "expiresAt": expires_at,
                "onchain": onchain,
                "attestation": attestation,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.tee_leg_attestation import TeeLegAttestation
        from ..models.tee_leg_onchain import TeeLegOnchain

        d = dict(src_dict)
        tee = check_tee_leg_tee(d.pop("tee"))

        signer = d.pop("signer")

        measurement = d.pop("measurement")

        registered_at = d.pop("registeredAt")

        verified_at = d.pop("verifiedAt")

        expires_at = d.pop("expiresAt")

        def _parse_onchain(data: object) -> TeeLegOnchain | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                onchain_type_0 = TeeLegOnchain.from_dict(data)

                return onchain_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | TeeLegOnchain, data)

        onchain = _parse_onchain(d.pop("onchain"))

        attestation = TeeLegAttestation.from_dict(d.pop("attestation"))

        tee_leg = cls(
            tee=tee,
            signer=signer,
            measurement=measurement,
            registered_at=registered_at,
            verified_at=verified_at,
            expires_at=expires_at,
            onchain=onchain,
            attestation=attestation,
        )

        tee_leg.additional_properties = d
        return tee_leg

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
