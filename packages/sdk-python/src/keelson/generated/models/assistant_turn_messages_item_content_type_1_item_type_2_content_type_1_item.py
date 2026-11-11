from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item_type import (
    AssistantTurnMessagesItemContentType1ItemType2ContentType1ItemType,
    check_assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item_type,
)

T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType2ContentType1Item")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType2ContentType1Item:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType2ContentType1ItemType):
        text (str):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType2ContentType1ItemType
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
        type_ = (
            check_assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item_type(
                d.pop("type")
            )
        )

        text = d.pop("text")

        assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item = cls(
            type_=type_,
            text=text,
        )

        return assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item
