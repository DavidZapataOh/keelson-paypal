from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.timestamp_role import TimestampRole, check_timestamp_role
from ..models.timestamp_tsa import TimestampTsa, check_timestamp_tsa

T = TypeVar("T", bound="Timestamp")


@_attrs_define
class Timestamp:
    """
    Attributes:
        tsa (TimestampTsa):
        role (TimestampRole):
        token (str): The DER `TimeStampToken`, base64.
        gen_time (str): The token's `genTime`, RFC 3339 UTC.
        serial (str): The token's serial number, hex.
    """

    tsa: TimestampTsa
    role: TimestampRole
    token: str
    gen_time: str
    serial: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        tsa: str = self.tsa

        role: str = self.role

        token = self.token

        gen_time = self.gen_time

        serial = self.serial

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "tsa": tsa,
                "role": role,
                "token": token,
                "genTime": gen_time,
                "serial": serial,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        tsa = check_timestamp_tsa(d.pop("tsa"))

        role = check_timestamp_role(d.pop("role"))

        token = d.pop("token")

        gen_time = d.pop("genTime")

        serial = d.pop("serial")

        timestamp = cls(
            tsa=tsa,
            role=role,
            token=token,
            gen_time=gen_time,
            serial=serial,
        )

        timestamp.additional_properties = d
        return timestamp

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
