from typing import Literal

AssistantTurnToolChoice = Literal["auto", "none"]

ASSISTANT_TURN_TOOL_CHOICE_VALUES: set[AssistantTurnToolChoice] = {
    "auto",
    "none",
}


def check_assistant_turn_tool_choice(value: str) -> AssistantTurnToolChoice:
    if value in ASSISTANT_TURN_TOOL_CHOICE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {ASSISTANT_TURN_TOOL_CHOICE_VALUES!r}"
    )
