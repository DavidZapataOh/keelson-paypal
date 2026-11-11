from typing import Literal

MandateCardRowsItemAnswers = Literal["Agent operator", "Keelson", "You"]

MANDATE_CARD_ROWS_ITEM_ANSWERS_VALUES: set[MandateCardRowsItemAnswers] = {
    "Agent operator",
    "Keelson",
    "You",
}


def check_mandate_card_rows_item_answers(value: str) -> MandateCardRowsItemAnswers:
    if value in MANDATE_CARD_ROWS_ITEM_ANSWERS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_CARD_ROWS_ITEM_ANSWERS_VALUES!r}"
    )
