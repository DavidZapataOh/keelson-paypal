from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_mandate_connection import CreateMandateConnection
    from ..models.create_mandate_payload_sd import CreateMandatePayloadSd
    from ..models.passkey_assertion import PasskeyAssertion


T = TypeVar("T", bound="CreateMandate")


@_attrs_define
class CreateMandate:
    """
    Attributes:
        payload_sd (CreateMandatePayloadSd): The SD-JWT payload with its `_sd` digests, as signed.
        disclosures (list[str]): Every disclosure of the payload; each digest must resolve.
        commitment (str): `C_m`; must equal the payload's `zk.commitment`.
        assertion (PasskeyAssertion): A WebAuthn or Secure Payment Confirmation assertion, base64url fields.
        salt (str | Unset): The salt that opens `C_m`; the TEE needs it to issue the mandate.
        connection (CreateMandateConnection | Unset): The agent's request this mandate approves, by its user code. The
            mandate must name the asking agent's operator and grant no more than it asked; `askAboveMinor` may only be lower
            too.
    """

    payload_sd: CreateMandatePayloadSd
    disclosures: list[str]
    commitment: str
    assertion: PasskeyAssertion
    salt: str | Unset = UNSET
    connection: CreateMandateConnection | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload_sd = self.payload_sd.to_dict()

        disclosures = self.disclosures

        commitment = self.commitment

        assertion = self.assertion.to_dict()

        salt = self.salt

        connection: dict[str, Any] | Unset = UNSET
        if not isinstance(self.connection, Unset):
            connection = self.connection.to_dict()

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
        if connection is not UNSET:
            field_dict["connection"] = connection

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_mandate_connection import CreateMandateConnection
        from ..models.create_mandate_payload_sd import CreateMandatePayloadSd
        from ..models.passkey_assertion import PasskeyAssertion

        d = dict(src_dict)
        payload_sd = CreateMandatePayloadSd.from_dict(d.pop("payloadSd"))

        disclosures = cast(list[str], d.pop("disclosures"))

        commitment = d.pop("commitment")

        assertion = PasskeyAssertion.from_dict(d.pop("assertion"))

        salt = d.pop("salt", UNSET)

        _connection = d.pop("connection", UNSET)
        connection: CreateMandateConnection | Unset
        if isinstance(_connection, Unset):
            connection = UNSET
        else:
            connection = CreateMandateConnection.from_dict(_connection)

        create_mandate = cls(
            payload_sd=payload_sd,
            disclosures=disclosures,
            commitment=commitment,
            assertion=assertion,
            salt=salt,
            connection=connection,
        )

        create_mandate.additional_properties = d
        return create_mandate

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
