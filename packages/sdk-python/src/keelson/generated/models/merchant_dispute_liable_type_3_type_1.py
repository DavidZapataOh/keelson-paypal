from typing import Literal

MerchantDisputeLiableType3Type1 = Literal["keelson", "merchant", "operator", "user"]

MERCHANT_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES: set[MerchantDisputeLiableType3Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_merchant_dispute_liable_type_3_type_1(value: str) -> MerchantDisputeLiableType3Type1:
    if value in MERCHANT_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES!r}"
    )
