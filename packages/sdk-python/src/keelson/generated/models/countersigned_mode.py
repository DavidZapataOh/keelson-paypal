from typing import Literal

CountersignedMode = Literal["2of2", "degraded"]

COUNTERSIGNED_MODE_VALUES: set[CountersignedMode] = {
    "2of2",
    "degraded",
}


def check_countersigned_mode(value: str) -> CountersignedMode:
    if value in COUNTERSIGNED_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {COUNTERSIGNED_MODE_VALUES!r}")
