from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.authorized_purchase_hold_state import (
    AuthorizedPurchaseHoldState,
    check_authorized_purchase_hold_state,
)

T = TypeVar("T", bound="AuthorizedPurchaseHold")


@_attrs_define
class AuthorizedPurchaseHold:
    """`PENDING` while PayPal reviews the authorization; asking again once it is created authorizes the hold.

    Attributes:
        request_id (str):
        state (AuthorizedPurchaseHoldState):
        authorization_id (str):
    """

    request_id: str
    state: AuthorizedPurchaseHoldState
    authorization_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        request_id = self.request_id

        state: str = self.state

        authorization_id = self.authorization_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "requestId": request_id,
                "state": state,
                "authorizationId": authorization_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        request_id = d.pop("requestId")

        state = check_authorized_purchase_hold_state(d.pop("state"))

        authorization_id = d.pop("authorizationId")

        authorized_purchase_hold = cls(
            request_id=request_id,
            state=state,
            authorization_id=authorization_id,
        )

        authorized_purchase_hold.additional_properties = d
        return authorized_purchase_hold

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
