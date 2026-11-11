from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_1_type import (
    AssistantTurnMessagesItemContentType1ItemType1Type,
    check_assistant_turn_messages_item_content_type_1_item_type_1_type,
)

if TYPE_CHECKING:
    from ..models.assistant_turn_messages_item_content_type_1_item_type_1_input import (
        AssistantTurnMessagesItemContentType1ItemType1Input,
    )


T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType1")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType1:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType1Type):
        id (str):
        name (str):
        input_ (AssistantTurnMessagesItemContentType1ItemType1Input):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType1Type
    id: str
    name: str
    input_: AssistantTurnMessagesItemContentType1ItemType1Input

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        id = self.id

        name = self.name

        input_ = self.input_.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "id": id,
                "name": name,
                "input": input_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.assistant_turn_messages_item_content_type_1_item_type_1_input import (
            AssistantTurnMessagesItemContentType1ItemType1Input,
        )

        d = dict(src_dict)
        type_ = check_assistant_turn_messages_item_content_type_1_item_type_1_type(d.pop("type"))

        id = d.pop("id")

        name = d.pop("name")

        input_ = AssistantTurnMessagesItemContentType1ItemType1Input.from_dict(d.pop("input"))

        assistant_turn_messages_item_content_type_1_item_type_1 = cls(
            type_=type_,
            id=id,
            name=name,
            input_=input_,
        )

        return assistant_turn_messages_item_content_type_1_item_type_1
