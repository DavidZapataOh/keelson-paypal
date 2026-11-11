from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_content_type_1_item_type_2_type import (
    AssistantTurnMessagesItemContentType1ItemType2Type,
    check_assistant_turn_messages_item_content_type_1_item_type_2_type,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item import (
        AssistantTurnMessagesItemContentType1ItemType2ContentType1Item,
    )


T = TypeVar("T", bound="AssistantTurnMessagesItemContentType1ItemType2")


@_attrs_define
class AssistantTurnMessagesItemContentType1ItemType2:
    """
    Attributes:
        type_ (AssistantTurnMessagesItemContentType1ItemType2Type):
        tool_use_id (str):
        content (list[AssistantTurnMessagesItemContentType1ItemType2ContentType1Item] | str):
        is_error (bool | Unset):
    """

    type_: AssistantTurnMessagesItemContentType1ItemType2Type
    tool_use_id: str
    content: list[AssistantTurnMessagesItemContentType1ItemType2ContentType1Item] | str
    is_error: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        tool_use_id = self.tool_use_id

        content: list[dict[str, Any]] | str
        if isinstance(self.content, list):
            content = []
            for content_type_1_item_data in self.content:
                content_type_1_item = content_type_1_item_data.to_dict()
                content.append(content_type_1_item)

        else:
            content = self.content

        is_error = self.is_error

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "tool_use_id": tool_use_id,
                "content": content,
            }
        )
        if is_error is not UNSET:
            field_dict["is_error"] = is_error

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.assistant_turn_messages_item_content_type_1_item_type_2_content_type_1_item import (
            AssistantTurnMessagesItemContentType1ItemType2ContentType1Item,
        )

        d = dict(src_dict)
        type_ = check_assistant_turn_messages_item_content_type_1_item_type_2_type(d.pop("type"))

        tool_use_id = d.pop("tool_use_id")

        def _parse_content(
            data: object,
        ) -> list[AssistantTurnMessagesItemContentType1ItemType2ContentType1Item] | str:
            try:
                if not isinstance(data, list):
                    raise TypeError()
                content_type_1 = []
                _content_type_1 = data
                for content_type_1_item_data in _content_type_1:
                    content_type_1_item = (
                        AssistantTurnMessagesItemContentType1ItemType2ContentType1Item.from_dict(
                            content_type_1_item_data
                        )
                    )

                    content_type_1.append(content_type_1_item)

                return content_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                list[AssistantTurnMessagesItemContentType1ItemType2ContentType1Item] | str, data
            )

        content = _parse_content(d.pop("content"))

        is_error = d.pop("is_error", UNSET)

        assistant_turn_messages_item_content_type_1_item_type_2 = cls(
            type_=type_,
            tool_use_id=tool_use_id,
            content=content,
            is_error=is_error,
        )

        return assistant_turn_messages_item_content_type_1_item_type_2
