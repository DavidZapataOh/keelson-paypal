from typing import Literal

AssistantTurnMessagesItemContentType1ItemType0Type = Literal["text"]

ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_0_TYPE_VALUES: set[
    AssistantTurnMessagesItemContentType1ItemType0Type
] = {
    "text",
}


def check_assistant_turn_messages_item_content_type_1_item_type_0_type(
    value: str,
) -> AssistantTurnMessagesItemContentType1ItemType0Type:
    if value in ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_0_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_0_TYPE_VALUES!r}"
    )
