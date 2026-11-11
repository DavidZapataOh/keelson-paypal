from typing import Literal

PurchaseModeType3Type1 = Literal["2of2", "degraded"]

PURCHASE_MODE_TYPE_3_TYPE_1_VALUES: set[PurchaseModeType3Type1] = {
    "2of2",
    "degraded",
}


def check_purchase_mode_type_3_type_1(value: str) -> PurchaseModeType3Type1:
    if value in PURCHASE_MODE_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {PURCHASE_MODE_TYPE_3_TYPE_1_VALUES!r}"
    )
