from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.authorized_hold_state import AuthorizedHoldState, check_authorized_hold_state

T = TypeVar("T", bound="AuthorizedHold")


@_attrs_define
class AuthorizedHold:
    """
    Attributes:
        state (AuthorizedHoldState):
        authorization_id (str):
        expires_at (datetime.datetime): When PayPal expires the authorization, 29 days after it was created.
    """

    state: AuthorizedHoldState
    authorization_id: str
    expires_at: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        state: str = self.state

        authorization_id = self.authorization_id

        expires_at = self.expires_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "state": state,
                "authorizationId": authorization_id,
                "expiresAt": expires_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        state = check_authorized_hold_state(d.pop("state"))

        authorization_id = d.pop("authorizationId")

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        authorized_hold = cls(
            state=state,
            authorization_id=authorization_id,
            expires_at=expires_at,
        )

        authorized_hold.additional_properties = d
        return authorized_hold

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
