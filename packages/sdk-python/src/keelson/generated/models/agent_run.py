from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.agent_run_state import AgentRunState, check_agent_run_state
from ..types import UNSET, Unset

T = TypeVar("T", bound="AgentRun")


@_attrs_define
class AgentRun:
    """
    Attributes:
        state (AgentRunState):
        live_view_url (str | Unset): Kernel's live view of the agent's browser, opened read-only.
    """

    state: AgentRunState
    live_view_url: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        state: str = self.state

        live_view_url = self.live_view_url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "state": state,
            }
        )
        if live_view_url is not UNSET:
            field_dict["liveViewUrl"] = live_view_url

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        state = check_agent_run_state(d.pop("state"))

        live_view_url = d.pop("liveViewUrl", UNSET)

        agent_run = cls(
            state=state,
            live_view_url=live_view_url,
        )

        agent_run.additional_properties = d
        return agent_run

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
