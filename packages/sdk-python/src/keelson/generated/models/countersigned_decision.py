from typing import Literal

CountersignedDecision = Literal["allow", "deny"]

COUNTERSIGNED_DECISION_VALUES: set[CountersignedDecision] = {
    "allow",
    "deny",
}


def check_countersigned_decision(value: str) -> CountersignedDecision:
    if value in COUNTERSIGNED_DECISION_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COUNTERSIGNED_DECISION_VALUES!r}"
    )
