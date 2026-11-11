from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.push_subscription_keys import PushSubscriptionKeys


T = TypeVar("T", bound="PushSubscription")


@_attrs_define
class PushSubscription:
    """
    Attributes:
        endpoint (str):
        keys (PushSubscriptionKeys):
        expiration_time (float | None | Unset):
    """

    endpoint: str
    keys: PushSubscriptionKeys
    expiration_time: float | Unset | None = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        endpoint = self.endpoint

        keys = self.keys.to_dict()

        expiration_time: float | Unset | None
        if isinstance(self.expiration_time, Unset):
            expiration_time = UNSET
        else:
            expiration_time = self.expiration_time

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "endpoint": endpoint,
                "keys": keys,
            }
        )
        if expiration_time is not UNSET:
            field_dict["expirationTime"] = expiration_time

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.push_subscription_keys import PushSubscriptionKeys

        d = dict(src_dict)
        endpoint = d.pop("endpoint")

        keys = PushSubscriptionKeys.from_dict(d.pop("keys"))

        def _parse_expiration_time(data: object) -> float | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(float | None | Unset, data)

        expiration_time = _parse_expiration_time(d.pop("expirationTime", UNSET))

        push_subscription = cls(
            endpoint=endpoint,
            keys=keys,
            expiration_time=expiration_time,
        )

        push_subscription.additional_properties = d
        return push_subscription

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
