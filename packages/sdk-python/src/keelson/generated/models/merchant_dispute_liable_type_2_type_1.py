from typing import Literal

MerchantDisputeLiableType2Type1 = Literal["keelson", "merchant", "operator", "user"]

MERCHANT_DISPUTE_LIABLE_TYPE_2_TYPE_1_VALUES: set[MerchantDisputeLiableType2Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_merchant_dispute_liable_type_2_type_1(value: str) -> MerchantDisputeLiableType2Type1:
    if value in MERCHANT_DISPUTE_LIABLE_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_LIABLE_TYPE_2_TYPE_1_VALUES!r}"
    )
