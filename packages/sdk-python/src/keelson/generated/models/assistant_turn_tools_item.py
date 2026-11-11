from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.assistant_turn_tools_item_input_schema import AssistantTurnToolsItemInputSchema


T = TypeVar("T", bound="AssistantTurnToolsItem")


@_attrs_define
class AssistantTurnToolsItem:
    """
    Attributes:
        name (str):
        description (str):
        input_schema (AssistantTurnToolsItemInputSchema):
    """

    name: str
    description: str
    input_schema: AssistantTurnToolsItemInputSchema

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        description = self.description

        input_schema = self.input_schema.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
                "description": description,
                "input_schema": input_schema,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.assistant_turn_tools_item_input_schema import (
            AssistantTurnToolsItemInputSchema,
        )

        d = dict(src_dict)
        name = d.pop("name")

        description = d.pop("description")

        input_schema = AssistantTurnToolsItemInputSchema.from_dict(d.pop("input_schema"))

        assistant_turn_tools_item = cls(
            name=name,
            description=description,
            input_schema=input_schema,
        )

        return assistant_turn_tools_item
