from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="CountersignRequestLive")


@_attrs_define
class CountersignRequestLive:
    """Only when the buyer pays at the store's own checkout with their own PayPal account: Keelson countersigns and logs
    the purchase and issues its Alibi, and neither covers nor captures it. Its Alibi is public once the PayPal
    transaction is recorded. The agent's pay click waits for an ALLOW; the agent then records PayPal's transaction id
    with `PUT /v1/purchases/{id}/paypal-transaction`.

        Attributes:
            store (str): The store's origin: the origin of the website the mandate allows for the cart's merchant.
    """

    store: str

    def to_dict(self) -> dict[str, Any]:
        store = self.store

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "store": store,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        store = d.pop("store")

        countersign_request_live = cls(
            store=store,
        )

        return countersign_request_live
