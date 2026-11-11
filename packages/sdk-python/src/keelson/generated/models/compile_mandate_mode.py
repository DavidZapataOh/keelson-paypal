from typing import Literal

CompileMandateMode = Literal["autonomous", "immediate"]

COMPILE_MANDATE_MODE_VALUES: set[CompileMandateMode] = {
    "autonomous",
    "immediate",
}


def check_compile_mandate_mode(value: str) -> CompileMandateMode:
    if value in COMPILE_MANDATE_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {COMPILE_MANDATE_MODE_VALUES!r}")
