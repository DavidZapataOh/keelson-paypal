from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.assistant_turn_messages_item_role import (
    AssistantTurnMessagesItemRole,
    check_assistant_turn_messages_item_role,
)

if TYPE_CHECKING:
    from ..models.assistant_turn_messages_item_content_type_1_item_type_0 import (
        AssistantTurnMessagesItemContentType1ItemType0,
    )
    from ..models.assistant_turn_messages_item_content_type_1_item_type_1 import (
        AssistantTurnMessagesItemContentType1ItemType1,
    )
    from ..models.assistant_turn_messages_item_content_type_1_item_type_2 import (
        AssistantTurnMessagesItemContentType1ItemType2,
    )
    from ..models.assistant_turn_messages_item_content_type_1_item_type_3 import (
        AssistantTurnMessagesItemContentType1ItemType3,
    )
    from ..models.assistant_turn_messages_item_content_type_1_item_type_4 import (
        AssistantTurnMessagesItemContentType1ItemType4,
    )


T = TypeVar("T", bound="AssistantTurnMessagesItem")


@_attrs_define
class AssistantTurnMessagesItem:
    """
    Attributes:
        role (AssistantTurnMessagesItemRole):
        content (list[AssistantTurnMessagesItemContentType1ItemType0 | AssistantTurnMessagesItemContentType1ItemType1 |
            AssistantTurnMessagesItemContentType1ItemType2 | AssistantTurnMessagesItemContentType1ItemType3 |
            AssistantTurnMessagesItemContentType1ItemType4] | str):
    """

    role: AssistantTurnMessagesItemRole
    content: (
        list[
            AssistantTurnMessagesItemContentType1ItemType0
            | AssistantTurnMessagesItemContentType1ItemType1
            | AssistantTurnMessagesItemContentType1ItemType2
            | AssistantTurnMessagesItemContentType1ItemType3
            | AssistantTurnMessagesItemContentType1ItemType4
        ]
        | str
    )

    def to_dict(self) -> dict[str, Any]:
        from ..models.assistant_turn_messages_item_content_type_1_item_type_0 import (
            AssistantTurnMessagesItemContentType1ItemType0,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_1 import (
            AssistantTurnMessagesItemContentType1ItemType1,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_2 import (
            AssistantTurnMessagesItemContentType1ItemType2,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_3 import (
            AssistantTurnMessagesItemContentType1ItemType3,
        )

        role: str = self.role

        content: list[dict[str, Any]] | str
        if isinstance(self.content, list):
            content = []
            for content_type_1_item_data in self.content:
                content_type_1_item: dict[str, Any]
                if (
                    isinstance(
                        content_type_1_item_data, AssistantTurnMessagesItemContentType1ItemType0
                    )
                    or isinstance(
                        content_type_1_item_data, AssistantTurnMessagesItemContentType1ItemType1
                    )
                    or isinstance(
                        content_type_1_item_data, AssistantTurnMessagesItemContentType1ItemType2
                    )
                    or isinstance(
                        content_type_1_item_data, AssistantTurnMessagesItemContentType1ItemType3
                    )
                ):
                    content_type_1_item = content_type_1_item_data.to_dict()
                else:
                    content_type_1_item = content_type_1_item_data.to_dict()

                content.append(content_type_1_item)

        else:
            content = self.content

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "role": role,
                "content": content,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.assistant_turn_messages_item_content_type_1_item_type_0 import (
            AssistantTurnMessagesItemContentType1ItemType0,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_1 import (
            AssistantTurnMessagesItemContentType1ItemType1,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_2 import (
            AssistantTurnMessagesItemContentType1ItemType2,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_3 import (
            AssistantTurnMessagesItemContentType1ItemType3,
        )
        from ..models.assistant_turn_messages_item_content_type_1_item_type_4 import (
            AssistantTurnMessagesItemContentType1ItemType4,
        )

        d = dict(src_dict)
        role = check_assistant_turn_messages_item_role(d.pop("role"))

        def _parse_content(
            data: object,
        ) -> (
            list[
                AssistantTurnMessagesItemContentType1ItemType0
                | AssistantTurnMessagesItemContentType1ItemType1
                | AssistantTurnMessagesItemContentType1ItemType2
                | AssistantTurnMessagesItemContentType1ItemType3
                | AssistantTurnMessagesItemContentType1ItemType4
            ]
            | str
        ):
            try:
                if not isinstance(data, list):
                    raise TypeError()
                content_type_1 = []
                _content_type_1 = data
                for content_type_1_item_data in _content_type_1:

                    def _parse_content_type_1_item(
                        data: object,
                    ) -> (
                        AssistantTurnMessagesItemContentType1ItemType0
                        | AssistantTurnMessagesItemContentType1ItemType1
                        | AssistantTurnMessagesItemContentType1ItemType2
                        | AssistantTurnMessagesItemContentType1ItemType3
                        | AssistantTurnMessagesItemContentType1ItemType4
                    ):
                        try:
                            if not isinstance(data, dict):
                                raise TypeError()
                            content_type_1_item_type_0 = (
                                AssistantTurnMessagesItemContentType1ItemType0.from_dict(data)
                            )

                            return content_type_1_item_type_0
                        except (TypeError, ValueError, AttributeError, KeyError):
                            pass
                        try:
                            if not isinstance(data, dict):
                                raise TypeError()
                            content_type_1_item_type_1 = (
                                AssistantTurnMessagesItemContentType1ItemType1.from_dict(data)
                            )

                            return content_type_1_item_type_1
                        except (TypeError, ValueError, AttributeError, KeyError):
                            pass
                        try:
                            if not isinstance(data, dict):
                                raise TypeError()
                            content_type_1_item_type_2 = (
                                AssistantTurnMessagesItemContentType1ItemType2.from_dict(data)
                            )

                            return content_type_1_item_type_2
                        except (TypeError, ValueError, AttributeError, KeyError):
                            pass
                        try:
                            if not isinstance(data, dict):
                                raise TypeError()
                            content_type_1_item_type_3 = (
                                AssistantTurnMessagesItemContentType1ItemType3.from_dict(data)
                            )

                            return content_type_1_item_type_3
                        except (TypeError, ValueError, AttributeError, KeyError):
                            pass
                        if not isinstance(data, dict):
                            raise TypeError()
                        content_type_1_item_type_4 = (
                            AssistantTurnMessagesItemContentType1ItemType4.from_dict(data)
                        )

                        return content_type_1_item_type_4

                    content_type_1_item = _parse_content_type_1_item(content_type_1_item_data)

                    content_type_1.append(content_type_1_item)

                return content_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                list[
                    AssistantTurnMessagesItemContentType1ItemType0
                    | AssistantTurnMessagesItemContentType1ItemType1
                    | AssistantTurnMessagesItemContentType1ItemType2
                    | AssistantTurnMessagesItemContentType1ItemType3
                    | AssistantTurnMessagesItemContentType1ItemType4
                ]
                | str,
                data,
            )

        content = _parse_content(d.pop("content"))

        assistant_turn_messages_item = cls(
            role=role,
            content=content,
        )

        return assistant_turn_messages_item
