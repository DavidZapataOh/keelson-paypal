from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_3_type import (
    AssistantTurnMessagesItemContentType1ItemType3Type,
    check_assistant_turn_messages_item_content_type_1_item_type_3_type,
)

T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType3")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType3:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType3Type):
        thinking (str):
        signature (str):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType3Type
    thinking: str
    signature: str

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        thinking = self.thinking

        signature = self.signature

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "thinking": thinking,
                "signature": signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_assistant_turn_messages_item_content_type_1_item_type_3_type(d.pop("type"))

        thinking = d.pop("thinking")

        signature = d.pop("signature")

        assistant_turn_messages_item_content_type_1_item_type_3 = cls(
            type_=type_,
            thinking=thinking,
            signature=signature,
        )

        return assistant_turn_messages_item_content_type_1_item_type_3
