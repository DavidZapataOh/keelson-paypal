from typing import Literal

MandateDraftV = Literal["keelson.mandate.1"]

MANDATE_DRAFT_V_VALUES: set[MandateDraftV] = {
    "keelson.mandate.1",
}


def check_mandate_draft_v(value: str) -> MandateDraftV:
    if value in MANDATE_DRAFT_V_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_V_VALUES!r}")
