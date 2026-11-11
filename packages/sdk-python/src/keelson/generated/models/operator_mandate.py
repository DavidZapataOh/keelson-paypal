from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.operator_mandate_hold_mode_type_1 import (
    OperatorMandateHoldModeType1,
    check_operator_mandate_hold_mode_type_1,
)
from ..models.operator_mandate_hold_mode_type_2_type_1 import (
    OperatorMandateHoldModeType2Type1,
    check_operator_mandate_hold_mode_type_2_type_1,
)
from ..models.operator_mandate_hold_mode_type_3_type_1 import (
    OperatorMandateHoldModeType3Type1,
    check_operator_mandate_hold_mode_type_3_type_1,
)
from ..models.operator_mandate_state import OperatorMandateState, check_operator_mandate_state

T = TypeVar("T", bound="OperatorMandate")


@_attrs_define
class OperatorMandate:
    """
    Attributes:
        id (str):
        state (OperatorMandateState):
        currency (str):
        max_minor (int):
        remaining_minor (int):
        expires_at (datetime.datetime):
        hold_mode (None | OperatorMandateHoldModeType1 | OperatorMandateHoldModeType2Type1 |
            OperatorMandateHoldModeType3Type1):
        authorization_id (None | str): The PayPal authorization that holds the mandate's funds, when the mandate is held
            as a whole.
        open_mandate (str): The mandate as issued, which the agent closes with its `cnf` key for each countersign.
    """

    id: str
    state: OperatorMandateState
    currency: str
    max_minor: int
    remaining_minor: int
    expires_at: datetime.datetime
    hold_mode: (
        OperatorMandateHoldModeType1
        | OperatorMandateHoldModeType2Type1
        | OperatorMandateHoldModeType3Type1
        | None
    )
    authorization_id: str | None
    open_mandate: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        state: str = self.state

        currency = self.currency

        max_minor = self.max_minor

        remaining_minor = self.remaining_minor

        expires_at = self.expires_at.isoformat()

        hold_mode: str | None
        if (
            isinstance(self.hold_mode, str)
            or isinstance(self.hold_mode, str)
            or isinstance(self.hold_mode, str)
        ):
            hold_mode = self.hold_mode
        else:
            hold_mode = self.hold_mode

        authorization_id: str | None
        authorization_id = self.authorization_id

        open_mandate = self.open_mandate

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "currency": currency,
                "maxMinor": max_minor,
                "remainingMinor": remaining_minor,
                "expiresAt": expires_at,
                "holdMode": hold_mode,
                "authorizationId": authorization_id,
                "openMandate": open_mandate,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        state = check_operator_mandate_state(d.pop("state"))

        currency = d.pop("currency")

        max_minor = d.pop("maxMinor")

        remaining_minor = d.pop("remainingMinor")

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        def _parse_hold_mode(
            data: object,
        ) -> (
            OperatorMandateHoldModeType1
            | OperatorMandateHoldModeType2Type1
            | OperatorMandateHoldModeType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                hold_mode_type_1 = check_operator_mandate_hold_mode_type_1(data)

                return hold_mode_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                hold_mode_type_2_type_1 = check_operator_mandate_hold_mode_type_2_type_1(data)

                return hold_mode_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                hold_mode_type_3_type_1 = check_operator_mandate_hold_mode_type_3_type_1(data)

                return hold_mode_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                None
                | OperatorMandateHoldModeType1
                | OperatorMandateHoldModeType2Type1
                | OperatorMandateHoldModeType3Type1,
                data,
            )

        hold_mode = _parse_hold_mode(d.pop("holdMode"))

        def _parse_authorization_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        authorization_id = _parse_authorization_id(d.pop("authorizationId"))

        open_mandate = d.pop("openMandate")

        operator_mandate = cls(
            id=id,
            state=state,
            currency=currency,
            max_minor=max_minor,
            remaining_minor=remaining_minor,
            expires_at=expires_at,
            hold_mode=hold_mode,
            authorization_id=authorization_id,
            open_mandate=open_mandate,
        )

        operator_mandate.additional_properties = d
        return operator_mandate

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
