from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_webhooks_status import (
    GetStatusResponse200DependenciesWebhooksStatus,
    check_get_status_response_200_dependencies_webhooks_status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="GetStatusResponse200DependenciesWebhooks")


@_attrs_define
class GetStatusResponse200DependenciesWebhooks:
    """
    Attributes:
        status (GetStatusResponse200DependenciesWebhooksStatus):
        last_webhook_age_ms (int | Unset):
        last_poll_age_ms (int | Unset):
    """

    status: GetStatusResponse200DependenciesWebhooksStatus
    last_webhook_age_ms: int | Unset = UNSET
    last_poll_age_ms: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        last_webhook_age_ms = self.last_webhook_age_ms

        last_poll_age_ms = self.last_poll_age_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
            }
        )
        if last_webhook_age_ms is not UNSET:
            field_dict["lastWebhookAgeMs"] = last_webhook_age_ms
        if last_poll_age_ms is not UNSET:
            field_dict["lastPollAgeMs"] = last_poll_age_ms

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_webhooks_status(d.pop("status"))

        last_webhook_age_ms = d.pop("lastWebhookAgeMs", UNSET)

        last_poll_age_ms = d.pop("lastPollAgeMs", UNSET)

        get_status_response_200_dependencies_webhooks = cls(
            status=status,
            last_webhook_age_ms=last_webhook_age_ms,
            last_poll_age_ms=last_poll_age_ms,
        )

        get_status_response_200_dependencies_webhooks.additional_properties = d
        return get_status_response_200_dependencies_webhooks

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
