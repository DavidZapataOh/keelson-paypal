from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_chain_events_status import (
    GetStatusResponse200DependenciesChainEventsStatus,
    check_get_status_response_200_dependencies_chain_events_status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="GetStatusResponse200DependenciesChainEvents")


@_attrs_define
class GetStatusResponse200DependenciesChainEvents:
    """
    Attributes:
        status (GetStatusResponse200DependenciesChainEventsStatus):
        finalized_block (str | Unset):
        reconciled_age_ms (int | Unset):
    """

    status: GetStatusResponse200DependenciesChainEventsStatus
    finalized_block: str | Unset = UNSET
    reconciled_age_ms: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        finalized_block = self.finalized_block

        reconciled_age_ms = self.reconciled_age_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
            }
        )
        if finalized_block is not UNSET:
            field_dict["finalizedBlock"] = finalized_block
        if reconciled_age_ms is not UNSET:
            field_dict["reconciledAgeMs"] = reconciled_age_ms

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_chain_events_status(d.pop("status"))

        finalized_block = d.pop("finalizedBlock", UNSET)

        reconciled_age_ms = d.pop("reconciledAgeMs", UNSET)

        get_status_response_200_dependencies_chain_events = cls(
            status=status,
            finalized_block=finalized_block,
            reconciled_age_ms=reconciled_age_ms,
        )

        get_status_response_200_dependencies_chain_events.additional_properties = d
        return get_status_response_200_dependencies_chain_events

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
