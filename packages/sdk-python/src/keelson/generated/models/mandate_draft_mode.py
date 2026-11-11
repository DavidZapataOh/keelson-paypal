from typing import Literal

MandateDraftMode = Literal["autonomous", "immediate"]

MANDATE_DRAFT_MODE_VALUES: set[MandateDraftMode] = {
    "autonomous",
    "immediate",
}


def check_mandate_draft_mode(value: str) -> MandateDraftMode:
    if value in MANDATE_DRAFT_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_MODE_VALUES!r}")
