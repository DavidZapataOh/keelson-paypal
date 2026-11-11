from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.web_authn_response_type import WebAuthnResponseType, check_web_authn_response_type
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.web_authn_response_client_extension_results import (
        WebAuthnResponseClientExtensionResults,
    )
    from ..models.web_authn_response_response import WebAuthnResponseResponse


T = TypeVar("T", bound="WebAuthnResponse")


@_attrs_define
class WebAuthnResponse:
    """`PublicKeyCredential.toJSON()` of the ceremony the frame started.

    Attributes:
        id (str):
        raw_id (str):
        type_ (WebAuthnResponseType):
        response (WebAuthnResponseResponse):
        authenticator_attachment (str | Unset):
        client_extension_results (WebAuthnResponseClientExtensionResults | Unset):
    """

    id: str
    raw_id: str
    type_: WebAuthnResponseType
    response: WebAuthnResponseResponse
    authenticator_attachment: str | Unset = UNSET
    client_extension_results: WebAuthnResponseClientExtensionResults | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        raw_id = self.raw_id

        type_: str = self.type_

        response = self.response.to_dict()

        authenticator_attachment = self.authenticator_attachment

        client_extension_results: dict[str, Any] | Unset = UNSET
        if not isinstance(self.client_extension_results, Unset):
            client_extension_results = self.client_extension_results.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "rawId": raw_id,
                "type": type_,
                "response": response,
            }
        )
        if authenticator_attachment is not UNSET:
            field_dict["authenticatorAttachment"] = authenticator_attachment
        if client_extension_results is not UNSET:
            field_dict["clientExtensionResults"] = client_extension_results

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.web_authn_response_client_extension_results import (
            WebAuthnResponseClientExtensionResults,
        )
        from ..models.web_authn_response_response import WebAuthnResponseResponse

        d = dict(src_dict)
        id = d.pop("id")

        raw_id = d.pop("rawId")

        type_ = check_web_authn_response_type(d.pop("type"))

        response = WebAuthnResponseResponse.from_dict(d.pop("response"))

        authenticator_attachment = d.pop("authenticatorAttachment", UNSET)

        _client_extension_results = d.pop("clientExtensionResults", UNSET)
        client_extension_results: WebAuthnResponseClientExtensionResults | Unset
        if isinstance(_client_extension_results, Unset):
            client_extension_results = UNSET
        else:
            client_extension_results = WebAuthnResponseClientExtensionResults.from_dict(
                _client_extension_results
            )

        web_authn_response = cls(
            id=id,
            raw_id=raw_id,
            type_=type_,
            response=response,
            authenticator_attachment=authenticator_attachment,
            client_extension_results=client_extension_results,
        )

        web_authn_response.additional_properties = d
        return web_authn_response

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
