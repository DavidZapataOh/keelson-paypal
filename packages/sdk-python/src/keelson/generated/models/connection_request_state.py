from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.connection_request_state_kind import (
    ConnectionRequestStateKind,
    check_connection_request_state_kind,
)
from ..models.connection_request_state_state import (
    ConnectionRequestStateState,
    check_connection_request_state_state,
)

T = TypeVar("T", bound="ConnectionRequestState")


@_attrs_define
class ConnectionRequestState:
    """
    Attributes:
        id (str):
        kind (ConnectionRequestStateKind):
        state (ConnectionRequestStateState):
        mandate_id (None | str): The mandate the user signed.
        parent_mandate_id (None | str):
        user_code (str):
        approval_url (str):
        match_number (int | None):
        expires_at (str):
        interval (int):
    """

    id: str
    kind: ConnectionRequestStateKind
    state: ConnectionRequestStateState
    mandate_id: str | None
    parent_mandate_id: str | None
    user_code: str
    approval_url: str
    match_number: int | None
    expires_at: str
    interval: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        kind: str = self.kind

        state: str = self.state

        mandate_id: str | None
        mandate_id = self.mandate_id

        parent_mandate_id: str | None
        parent_mandate_id = self.parent_mandate_id

        user_code = self.user_code

        approval_url = self.approval_url

        match_number: int | None
        match_number = self.match_number

        expires_at = self.expires_at

        interval = self.interval

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "kind": kind,
                "state": state,
                "mandateId": mandate_id,
                "parentMandateId": parent_mandate_id,
                "userCode": user_code,
                "approvalUrl": approval_url,
                "matchNumber": match_number,
                "expiresAt": expires_at,
                "interval": interval,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        kind = check_connection_request_state_kind(d.pop("kind"))

        state = check_connection_request_state_state(d.pop("state"))

        def _parse_mandate_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate_id = _parse_mandate_id(d.pop("mandateId"))

        def _parse_parent_mandate_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        parent_mandate_id = _parse_parent_mandate_id(d.pop("parentMandateId"))

        user_code = d.pop("userCode")

        approval_url = d.pop("approvalUrl")

        def _parse_match_number(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        match_number = _parse_match_number(d.pop("matchNumber"))

        expires_at = d.pop("expiresAt")

        interval = d.pop("interval")

        connection_request_state = cls(
            id=id,
            kind=kind,
            state=state,
            mandate_id=mandate_id,
            parent_mandate_id=parent_mandate_id,
            user_code=user_code,
            approval_url=approval_url,
            match_number=match_number,
            expires_at=expires_at,
            interval=interval,
        )

        connection_request_state.additional_properties = d
        return connection_request_state

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
