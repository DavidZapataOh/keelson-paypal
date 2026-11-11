from typing import Literal

AssistantTurnMessagesItemRole = Literal["assistant", "user"]

ASSISTANT_TURN_MESSAGES_ITEM_ROLE_VALUES: set[AssistantTurnMessagesItemRole] = {
    "assistant",
    "user",
}


def check_assistant_turn_messages_item_role(value: str) -> AssistantTurnMessagesItemRole:
    if value in ASSISTANT_TURN_MESSAGES_ITEM_ROLE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {ASSISTANT_TURN_MESSAGES_ITEM_ROLE_VALUES!r}"
    )
