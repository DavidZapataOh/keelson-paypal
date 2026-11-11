from typing import Literal

AssistantTurnMessagesItemContentType1ItemType2Type = Literal["tool_result"]

ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_2_TYPE_VALUES: set[
    AssistantTurnMessagesItemContentType1ItemType2Type
] = {
    "tool_result",
}


def check_assistant_turn_messages_item_content_type_1_item_type_2_type(
    value: str,
) -> AssistantTurnMessagesItemContentType1ItemType2Type:
    if value in ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {ASSISTANT_TURN_MESSAGES_ITEM_CONTENT_TYPE_1_ITEM_TYPE_2_TYPE_VALUES!r}"
    )
