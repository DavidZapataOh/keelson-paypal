from typing import Literal

MandateRail = Literal["card", "paypal"]

MANDATE_RAIL_VALUES: set[MandateRail] = {
    "card",
    "paypal",
}


def check_mandate_rail(value: str) -> MandateRail:
    if value in MANDATE_RAIL_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_RAIL_VALUES!r}")
