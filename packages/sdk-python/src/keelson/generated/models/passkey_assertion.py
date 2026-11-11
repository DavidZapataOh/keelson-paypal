from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="PasskeyAssertion")


@_attrs_define
class PasskeyAssertion:
    """A WebAuthn or Secure Payment Confirmation assertion, base64url fields.

    Attributes:
        authenticator_data (str):
        client_data_json (str):
        signature (str):
        credential_id (str):
        user_handle (str | Unset):
    """

    authenticator_data: str
    client_data_json: str
    signature: str
    credential_id: str
    user_handle: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        authenticator_data = self.authenticator_data

        client_data_json = self.client_data_json

        signature = self.signature

        credential_id = self.credential_id

        user_handle = self.user_handle

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "authenticatorData": authenticator_data,
                "clientDataJSON": client_data_json,
                "signature": signature,
                "credentialId": credential_id,
            }
        )
        if user_handle is not UNSET:
            field_dict["userHandle"] = user_handle

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        authenticator_data = d.pop("authenticatorData")

        client_data_json = d.pop("clientDataJSON")

        signature = d.pop("signature")

        credential_id = d.pop("credentialId")

        user_handle = d.pop("userHandle", UNSET)

        passkey_assertion = cls(
            authenticator_data=authenticator_data,
            client_data_json=client_data_json,
            signature=signature,
            credential_id=credential_id,
            user_handle=user_handle,
        )

        passkey_assertion.additional_properties = d
        return passkey_assertion

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
