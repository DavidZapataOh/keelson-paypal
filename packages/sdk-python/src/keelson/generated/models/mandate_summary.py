from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.mandate_summary_hold_mode import (
    MandateSummaryHoldMode,
    check_mandate_summary_hold_mode,
)
from ..models.mandate_summary_state import MandateSummaryState, check_mandate_summary_state

if TYPE_CHECKING:
    from ..models.mandate_budget import MandateBudget


T = TypeVar("T", bound="MandateSummary")


@_attrs_define
class MandateSummary:
    """
    Attributes:
        id (str):
        state (MandateSummaryState):
        budget (MandateBudget): The mandate's budget and what is left of it, in minor units.
        merchant_ids (list[str]):
        hold_mode (MandateSummaryHoldMode):
        expires_at (datetime.datetime):
        created_at (datetime.datetime):
    """

    id: str
    state: MandateSummaryState
    budget: MandateBudget
    merchant_ids: list[str]
    hold_mode: MandateSummaryHoldMode
    expires_at: datetime.datetime
    created_at: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        state: str = self.state

        budget = self.budget.to_dict()

        merchant_ids = self.merchant_ids

        hold_mode: str = self.hold_mode

        expires_at = self.expires_at.isoformat()

        created_at = self.created_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "budget": budget,
                "merchantIds": merchant_ids,
                "holdMode": hold_mode,
                "expiresAt": expires_at,
                "createdAt": created_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_budget import MandateBudget

        d = dict(src_dict)
        id = d.pop("id")

        state = check_mandate_summary_state(d.pop("state"))

        budget = MandateBudget.from_dict(d.pop("budget"))

        merchant_ids = cast(list[str], d.pop("merchantIds"))

        hold_mode = check_mandate_summary_hold_mode(d.pop("holdMode"))

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        mandate_summary = cls(
            id=id,
            state=state,
            budget=budget,
            merchant_ids=merchant_ids,
            hold_mode=hold_mode,
            expires_at=expires_at,
            created_at=created_at,
        )

        mandate_summary.additional_properties = d
        return mandate_summary

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
