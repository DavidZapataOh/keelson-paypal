from typing import Literal

OperatorMandateState = Literal["ACTIVE"]

OPERATOR_MANDATE_STATE_VALUES: set[OperatorMandateState] = {
    "ACTIVE",
}


def check_operator_mandate_state(value: str) -> OperatorMandateState:
    if value in OPERATOR_MANDATE_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {OPERATOR_MANDATE_STATE_VALUES!r}"
    )
