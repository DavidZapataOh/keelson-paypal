from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.mandate_hold_mode import MandateHoldMode, check_mandate_hold_mode
from ..models.mandate_hold_state import MandateHoldState, check_mandate_hold_state

T = TypeVar("T", bound="MandateHold")


@_attrs_define
class MandateHold:
    """
    Attributes:
        mode (MandateHoldMode):
        order_id (str):
        authorization_id (None | str): The authorization captures use: the original, or its reauthorization.
        authorized_at (datetime.datetime | None):
        reauthorized_at (datetime.datetime | None):
        remaining_minor (str):
        state (MandateHoldState): `PENDING` until authorized; `RELEASED` once the mandate ended and the hold was voided
            or captured.
    """

    mode: MandateHoldMode
    order_id: str
    authorization_id: str | None
    authorized_at: datetime.datetime | None
    reauthorized_at: datetime.datetime | None
    remaining_minor: str
    state: MandateHoldState
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mode: str = self.mode

        order_id = self.order_id

        authorization_id: str | None
        authorization_id = self.authorization_id

        authorized_at: str | None
        if isinstance(self.authorized_at, datetime.datetime):
            authorized_at = self.authorized_at.isoformat()
        else:
            authorized_at = self.authorized_at

        reauthorized_at: str | None
        if isinstance(self.reauthorized_at, datetime.datetime):
            reauthorized_at = self.reauthorized_at.isoformat()
        else:
            reauthorized_at = self.reauthorized_at

        remaining_minor = self.remaining_minor

        state: str = self.state

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mode": mode,
                "orderId": order_id,
                "authorizationId": authorization_id,
                "authorizedAt": authorized_at,
                "reauthorizedAt": reauthorized_at,
                "remainingMinor": remaining_minor,
                "state": state,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        mode = check_mandate_hold_mode(d.pop("mode"))

        order_id = d.pop("orderId")

        def _parse_authorization_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        authorization_id = _parse_authorization_id(d.pop("authorizationId"))

        def _parse_authorized_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                authorized_at_type_0 = datetime.datetime.fromisoformat(data)

                return authorized_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        authorized_at = _parse_authorized_at(d.pop("authorizedAt"))

        def _parse_reauthorized_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                reauthorized_at_type_0 = datetime.datetime.fromisoformat(data)

                return reauthorized_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        reauthorized_at = _parse_reauthorized_at(d.pop("reauthorizedAt"))

        remaining_minor = d.pop("remainingMinor")

        state = check_mandate_hold_state(d.pop("state"))

        mandate_hold = cls(
            mode=mode,
            order_id=order_id,
            authorization_id=authorization_id,
            authorized_at=authorized_at,
            reauthorized_at=reauthorized_at,
            remaining_minor=remaining_minor,
            state=state,
        )

        mandate_hold.additional_properties = d
        return mandate_hold

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
