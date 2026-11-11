from typing import Literal

ActivityRowTone = Literal["bad", "good", "warn"]

ACTIVITY_ROW_TONE_VALUES: set[ActivityRowTone] = {
    "bad",
    "good",
    "warn",
}


def check_activity_row_tone(value: str) -> ActivityRowTone:
    if value in ACTIVITY_ROW_TONE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {ACTIVITY_ROW_TONE_VALUES!r}")
