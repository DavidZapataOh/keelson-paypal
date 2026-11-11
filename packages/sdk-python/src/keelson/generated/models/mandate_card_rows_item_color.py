from typing import Literal

MandateCardRowsItemColor = Literal["amber", "gray", "green"]

MANDATE_CARD_ROWS_ITEM_COLOR_VALUES: set[MandateCardRowsItemColor] = {
    "amber",
    "gray",
    "green",
}


def check_mandate_card_rows_item_color(value: str) -> MandateCardRowsItemColor:
    if value in MANDATE_CARD_ROWS_ITEM_COLOR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_CARD_ROWS_ITEM_COLOR_VALUES!r}"
    )
