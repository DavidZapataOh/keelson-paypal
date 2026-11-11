from typing import Literal

ConnectionLimitsMerchantsItem = Literal["mrc_runfast"]

CONNECTION_LIMITS_MERCHANTS_ITEM_VALUES: set[ConnectionLimitsMerchantsItem] = {
    "mrc_runfast",
}


def check_connection_limits_merchants_item(value: str) -> ConnectionLimitsMerchantsItem:
    if value in CONNECTION_LIMITS_MERCHANTS_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_LIMITS_MERCHANTS_ITEM_VALUES!r}"
    )
