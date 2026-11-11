from typing import Literal

SetSettlementResponse200Rail = Literal["paypal", "pyusd"]

SET_SETTLEMENT_RESPONSE_200_RAIL_VALUES: set[SetSettlementResponse200Rail] = {
    "paypal",
    "pyusd",
}


def check_set_settlement_response_200_rail(value: str) -> SetSettlementResponse200Rail:
    if value in SET_SETTLEMENT_RESPONSE_200_RAIL_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {SET_SETTLEMENT_RESPONSE_200_RAIL_VALUES!r}"
    )
