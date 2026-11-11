from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.pay_pal_client_environment import (
    PayPalClientEnvironment,
    check_pay_pal_client_environment,
)

T = TypeVar("T", bound="PayPalClient")


@_attrs_define
class PayPalClient:
    """
    Attributes:
        client_id (str):
        environment (PayPalClientEnvironment):
    """

    client_id: str
    environment: PayPalClientEnvironment
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        client_id = self.client_id

        environment: str = self.environment

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "clientId": client_id,
                "environment": environment,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        client_id = d.pop("clientId")

        environment = check_pay_pal_client_environment(d.pop("environment"))

        pay_pal_client = cls(
            client_id=client_id,
            environment=environment,
        )

        pay_pal_client.additional_properties = d
        return pay_pal_client

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
