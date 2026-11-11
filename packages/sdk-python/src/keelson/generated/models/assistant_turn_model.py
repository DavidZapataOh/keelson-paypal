from typing import Literal

AssistantTurnModel = Literal["claude-haiku-5-5", "claude-opus-5-5"]

ASSISTANT_TURN_MODEL_VALUES: set[AssistantTurnModel] = {
    "claude-haiku-5-5",
    "claude-opus-5-5",
}


def check_assistant_turn_model(value: str) -> AssistantTurnModel:
    if value in ASSISTANT_TURN_MODEL_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {ASSISTANT_TURN_MODEL_VALUES!r}")
