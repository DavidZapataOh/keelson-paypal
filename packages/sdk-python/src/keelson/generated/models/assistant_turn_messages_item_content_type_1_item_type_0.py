from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_0_type import (
    AssistantTurnMessagesItemContentType1ItemType0Type,
    check_assistant_turn_messages_item_content_type_1_item_type_0_type,
)

T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType0")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType0:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType0Type):
        text (str):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType0Type
    text: str

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        text = self.text

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "text": text,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_assistant_turn_messages_item_content_type_1_item_type_0_type(d.pop("type"))

        text = d.pop("text")

        assistant_turn_messages_item_content_type_1_item_type_0 = cls(
            type_=type_,
            text=text,
        )

        return assistant_turn_messages_item_content_type_1_item_type_0
