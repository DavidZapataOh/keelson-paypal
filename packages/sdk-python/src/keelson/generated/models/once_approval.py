from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="OnceApproval")


@_attrs_define
class OnceApproval:
    """On a deny for a cart over the mandate's amount or outside its merchants: the user was asked to approve this cart
    once. Poll `POST /v1/connections/token` with its `device_code`; the answer is a single-purchase mandate for exactly
    this cart.

        Attributes:
            user_code (str):
            verification_uri (str):
            verification_uri_complete (str):
            expires_in (int):
            interval (int):
            request_id (str): Read the request's state with `GET /v1/connections/requests/{id}`.
            device_code (str | Unset): Absent when the user is already being asked about this cart: keep polling the device
                code you were given then.
    """

    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    request_id: str
    device_code: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        user_code = self.user_code

        verification_uri = self.verification_uri

        verification_uri_complete = self.verification_uri_complete

        expires_in = self.expires_in

        interval = self.interval

        request_id = self.request_id

        device_code = self.device_code

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "user_code": user_code,
                "verification_uri": verification_uri,
                "verification_uri_complete": verification_uri_complete,
                "expires_in": expires_in,
                "interval": interval,
                "request_id": request_id,
            }
        )
        if device_code is not UNSET:
            field_dict["device_code"] = device_code

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        user_code = d.pop("user_code")

        verification_uri = d.pop("verification_uri")

        verification_uri_complete = d.pop("verification_uri_complete")

        expires_in = d.pop("expires_in")

        interval = d.pop("interval")

        request_id = d.pop("request_id")

        device_code = d.pop("device_code", UNSET)

        once_approval = cls(
            user_code=user_code,
            verification_uri=verification_uri,
            verification_uri_complete=verification_uri_complete,
            expires_in=expires_in,
            interval=interval,
            request_id=request_id,
            device_code=device_code,
        )

        once_approval.additional_properties = d
        return once_approval

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
