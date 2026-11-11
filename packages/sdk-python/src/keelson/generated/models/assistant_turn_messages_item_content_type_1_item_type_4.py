from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_4_type import (
    AssistantTurnMessagesItemContentType1ItemType4Type,
    check_assistant_turn_messages_item_content_type_1_item_type_4_type,
)

T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType4")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType4:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType4Type):
        data (str):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType4Type
    data: str

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        data = self.data

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "data": data,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_assistant_turn_messages_item_content_type_1_item_type_4_type(d.pop("type"))

        data = d.pop("data")

        assistant_turn_messages_item_content_type_1_item_type_4 = cls(
            type_=type_,
            data=data,
        )

        return assistant_turn_messages_item_content_type_1_item_type_4
