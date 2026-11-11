from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.connection_token_error_error import (
    ConnectionTokenErrorError,
    check_connection_token_error_error,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="ConnectionTokenError")


@_attrs_define
class ConnectionTokenError:
    """
    Attributes:
        error (ConnectionTokenErrorError):
        error_description (str):
        interval (int | Unset):
    """

    error: ConnectionTokenErrorError
    error_description: str
    interval: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        error: str = self.error

        error_description = self.error_description

        interval = self.interval

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "error": error,
                "error_description": error_description,
            }
        )
        if interval is not UNSET:
            field_dict["interval"] = interval

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        error = check_connection_token_error_error(d.pop("error"))

        error_description = d.pop("error_description")

        interval = d.pop("interval", UNSET)

        connection_token_error = cls(
            error=error,
            error_description=error_description,
            interval=interval,
        )

        connection_token_error.additional_properties = d
        return connection_token_error

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
