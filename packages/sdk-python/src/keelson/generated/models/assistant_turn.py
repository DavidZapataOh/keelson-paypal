from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.assistant_turn_model import AssistantTurnModel, check_assistant_turn_model
from ..models.assistant_turn_tool_choice import (
    AssistantTurnToolChoice,
    check_assistant_turn_tool_choice,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.assistant_turn_messages_item import AssistantTurnMessagesItem
    from ..models.assistant_turn_tools_item import AssistantTurnToolsItem


T = TypeVar("T", bound="AssistantTurn")


@_attrs_define
class AssistantTurn:
    """One turn of the console's agents: Messages API `system`, `messages` and client `tools`. The proxy sets the model
    limits, thinking and effort.

        Attributes:
            system (str):
            messages (list[AssistantTurnMessagesItem]):
            model (AssistantTurnModel | Unset):
            tools (list[AssistantTurnToolsItem] | Unset):
            tool_choice (AssistantTurnToolChoice | Unset):
    """

    system: str
    messages: list[AssistantTurnMessagesItem]
    model: AssistantTurnModel | Unset = UNSET
    tools: list[AssistantTurnToolsItem] | Unset = UNSET
    tool_choice: AssistantTurnToolChoice | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        system = self.system

        messages = []
        for messages_item_data in self.messages:
            messages_item = messages_item_data.to_dict()
            messages.append(messages_item)

        model: str | Unset = UNSET
        if not isinstance(self.model, Unset):
            model = self.model

        tools: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.tools, Unset):
            tools = []
            for tools_item_data in self.tools:
                tools_item = tools_item_data.to_dict()
                tools.append(tools_item)

        tool_choice: str | Unset = UNSET
        if not isinstance(self.tool_choice, Unset):
            tool_choice = self.tool_choice

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "system": system,
                "messages": messages,
            }
        )
        if model is not UNSET:
            field_dict["model"] = model
        if tools is not UNSET:
            field_dict["tools"] = tools
        if tool_choice is not UNSET:
            field_dict["tool_choice"] = tool_choice

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.assistant_turn_messages_item import AssistantTurnMessagesItem
        from ..models.assistant_turn_tools_item import AssistantTurnToolsItem

        d = dict(src_dict)
        system = d.pop("system")

        messages = []
        _messages = d.pop("messages")
        for messages_item_data in _messages:
            messages_item = AssistantTurnMessagesItem.from_dict(messages_item_data)

            messages.append(messages_item)

        _model = d.pop("model", UNSET)
        model: AssistantTurnModel | Unset
        if isinstance(_model, Unset):
            model = UNSET
        else:
            model = check_assistant_turn_model(_model)

        _tools = d.pop("tools", UNSET)
        tools: list[AssistantTurnToolsItem] | Unset = UNSET
        if _tools is not UNSET:
            tools = []
            for tools_item_data in _tools:
                tools_item = AssistantTurnToolsItem.from_dict(tools_item_data)

                tools.append(tools_item)

        _tool_choice = d.pop("tool_choice", UNSET)
        tool_choice: AssistantTurnToolChoice | Unset
        if isinstance(_tool_choice, Unset):
            tool_choice = UNSET
        else:
            tool_choice = check_assistant_turn_tool_choice(_tool_choice)

        assistant_turn = cls(
            system=system,
            messages=messages,
            model=model,
            tools=tools,
            tool_choice=tool_choice,
        )

        assistant_turn.additional_properties = d
        return assistant_turn

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
