from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.revoking_mandate_state import RevokingMandateState, check_revoking_mandate_state

T = TypeVar("T", bound="RevokingMandate")


@_attrs_define
class RevokingMandate:
    """Purchases already countersigned may still be captured; the hold is voided after them.

    Attributes:
        state (RevokingMandateState):
    """

    state: RevokingMandateState
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        state: str = self.state

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "state": state,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        state = check_revoking_mandate_state(d.pop("state"))

        revoking_mandate = cls(
            state=state,
        )

        revoking_mandate.additional_properties = d
        return revoking_mandate

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
