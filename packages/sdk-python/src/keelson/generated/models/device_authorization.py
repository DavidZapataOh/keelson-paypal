from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="DeviceAuthorization")


@_attrs_define
class DeviceAuthorization:
    """RFC 8628 §3.2. Show `user_code` and `verification_uri` to the user, then poll `POST /v1/connections/token` every
    `interval` seconds.

        Attributes:
            device_code (str):
            user_code (str):
            verification_uri (str):
            verification_uri_complete (str):
            expires_in (int):
            interval (int):
            request_id (str): The request's id: `GET /v1/connections/requests/{id}` reads its state without spending the
                device code.
            match_number (int | Unset): Show it beside the link: the user picks it out of three before the request opens, so
                a link relayed by someone else does not.
    """

    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    request_id: str
    match_number: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        device_code = self.device_code

        user_code = self.user_code

        verification_uri = self.verification_uri

        verification_uri_complete = self.verification_uri_complete

        expires_in = self.expires_in

        interval = self.interval

        request_id = self.request_id

        match_number = self.match_number

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "device_code": device_code,
                "user_code": user_code,
                "verification_uri": verification_uri,
                "verification_uri_complete": verification_uri_complete,
                "expires_in": expires_in,
                "interval": interval,
                "request_id": request_id,
            }
        )
        if match_number is not UNSET:
            field_dict["match_number"] = match_number

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        device_code = d.pop("device_code")

        user_code = d.pop("user_code")

        verification_uri = d.pop("verification_uri")

        verification_uri_complete = d.pop("verification_uri_complete")

        expires_in = d.pop("expires_in")

        interval = d.pop("interval")

        request_id = d.pop("request_id")

        match_number = d.pop("match_number", UNSET)

        device_authorization = cls(
            device_code=device_code,
            user_code=user_code,
            verification_uri=verification_uri,
            verification_uri_complete=verification_uri_complete,
            expires_in=expires_in,
            interval=interval,
            request_id=request_id,
            match_number=match_number,
        )

        device_authorization.additional_properties = d
        return device_authorization

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
