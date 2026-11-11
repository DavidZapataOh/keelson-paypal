from typing import Literal

OperatorMandateHoldModeType3Type1 = Literal["mandate", "per_purchase"]

OPERATOR_MANDATE_HOLD_MODE_TYPE_3_TYPE_1_VALUES: set[OperatorMandateHoldModeType3Type1] = {
    "mandate",
    "per_purchase",
}


def check_operator_mandate_hold_mode_type_3_type_1(value: str) -> OperatorMandateHoldModeType3Type1:
    if value in OPERATOR_MANDATE_HOLD_MODE_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {OPERATOR_MANDATE_HOLD_MODE_TYPE_3_TYPE_1_VALUES!r}"
    )
