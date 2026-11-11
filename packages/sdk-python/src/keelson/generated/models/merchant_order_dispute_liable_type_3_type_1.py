from typing import Literal

MerchantOrderDisputeLiableType3Type1 = Literal["keelson", "merchant", "operator", "user"]

MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES: set[MerchantOrderDisputeLiableType3Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_merchant_order_dispute_liable_type_3_type_1(
    value: str,
) -> MerchantOrderDisputeLiableType3Type1:
    if value in MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_3_TYPE_1_VALUES!r}"
    )
