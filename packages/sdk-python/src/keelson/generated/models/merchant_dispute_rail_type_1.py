from typing import Literal

MerchantDisputeRailType1 = Literal["paypal", "pyusd"]

MERCHANT_DISPUTE_RAIL_TYPE_1_VALUES: set[MerchantDisputeRailType1] = {
    "paypal",
    "pyusd",
}


def check_merchant_dispute_rail_type_1(value: str) -> MerchantDisputeRailType1:
    if value in MERCHANT_DISPUTE_RAIL_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_RAIL_TYPE_1_VALUES!r}"
    )
