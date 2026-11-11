from typing import Literal

AmberCaseConvictionField = Literal["color", "returns_free", "size", "unit_price"]

AMBER_CASE_CONVICTION_FIELD_VALUES: set[AmberCaseConvictionField] = {
    "color",
    "returns_free",
    "size",
    "unit_price",
}


def check_amber_case_conviction_field(value: str) -> AmberCaseConvictionField:
    if value in AMBER_CASE_CONVICTION_FIELD_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {AMBER_CASE_CONVICTION_FIELD_VALUES!r}"
    )
