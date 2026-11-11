from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_embed_mandate_body_payload_sd import CreateEmbedMandateBodyPayloadSd
    from ..models.passkey_assertion import PasskeyAssertion


T = TypeVar("T", bound="CreateEmbedMandateBody")


@_attrs_define
class CreateEmbedMandateBody:
    """
    Attributes:
        payload_sd (CreateEmbedMandateBodyPayloadSd): The SD-JWT payload with its `_sd` digests, as signed.
        disclosures (list[str]): Every disclosure of the payload; each digest must resolve.
        commitment (str): `C_m`; must equal the payload's `zk.commitment`.
        assertion (PasskeyAssertion): A WebAuthn or Secure Payment Confirmation assertion, base64url fields.
        salt (str | Unset): The salt that opens `C_m`; the TEE needs it to issue the mandate.
        ask_above_minor (int | Unset):
    """

    payload_sd: CreateEmbedMandateBodyPayloadSd
    disclosures: list[str]
    commitment: str
    assertion: PasskeyAssertion
    salt: str | Unset = UNSET
    ask_above_minor: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload_sd = self.payload_sd.to_dict()

        disclosures = self.disclosures

        commitment = self.commitment

        assertion = self.assertion.to_dict()

        salt = self.salt

        ask_above_minor = self.ask_above_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "payloadSd": payload_sd,
                "disclosures": disclosures,
                "commitment": commitment,
                "assertion": assertion,
            }
        )
        if salt is not UNSET:
            field_dict["salt"] = salt
        if ask_above_minor is not UNSET:
            field_dict["askAboveMinor"] = ask_above_minor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_embed_mandate_body_payload_sd import CreateEmbedMandateBodyPayloadSd
        from ..models.passkey_assertion import PasskeyAssertion

        d = dict(src_dict)
        payload_sd = CreateEmbedMandateBodyPayloadSd.from_dict(d.pop("payloadSd"))

        disclosures = cast(list[str], d.pop("disclosures"))

        commitment = d.pop("commitment")

        assertion = PasskeyAssertion.from_dict(d.pop("assertion"))

        salt = d.pop("salt", UNSET)

        ask_above_minor = d.pop("askAboveMinor", UNSET)

        create_embed_mandate_body = cls(
            payload_sd=payload_sd,
            disclosures=disclosures,
            commitment=commitment,
            assertion=assertion,
            salt=salt,
            ask_above_minor=ask_above_minor,
        )

        create_embed_mandate_body.additional_properties = d
        return create_embed_mandate_body

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
