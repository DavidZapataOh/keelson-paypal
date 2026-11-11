from typing import Literal

MandateSummaryState = Literal[
    "ACTIVE", "COMPILED", "DRAFT", "EXHAUSTED", "EXPIRED", "HOLD_PENDING", "REVOKED", "SIGNED"
]

MANDATE_SUMMARY_STATE_VALUES: set[MandateSummaryState] = {
    "ACTIVE",
    "COMPILED",
    "DRAFT",
    "EXHAUSTED",
    "EXPIRED",
    "HOLD_PENDING",
    "REVOKED",
    "SIGNED",
}


def check_mandate_summary_state(value: str) -> MandateSummaryState:
    if value in MANDATE_SUMMARY_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_SUMMARY_STATE_VALUES!r}")
