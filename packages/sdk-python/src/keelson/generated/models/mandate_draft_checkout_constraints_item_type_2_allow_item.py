from typing import Literal

MandateDraftCheckoutConstraintsItemType2AllowItem = Literal[
    "gpt:1",
    "gpt:111",
    "gpt:1239",
    "gpt:141",
    "gpt:166",
    "gpt:187",
    "gpt:2092",
    "gpt:222",
    "gpt:412",
    "gpt:436",
    "gpt:469",
    "gpt:5181",
    "gpt:536",
    "gpt:537",
    "gpt:5605",
    "gpt:632",
    "gpt:772",
    "gpt:783",
    "gpt:8",
    "gpt:888",
    "gpt:922",
    "gpt:988",
]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_ALLOW_ITEM_VALUES: set[
    MandateDraftCheckoutConstraintsItemType2AllowItem
] = {
    "gpt:1",
    "gpt:111",
    "gpt:1239",
    "gpt:141",
    "gpt:166",
    "gpt:187",
    "gpt:2092",
    "gpt:222",
    "gpt:412",
    "gpt:436",
    "gpt:469",
    "gpt:5181",
    "gpt:536",
    "gpt:537",
    "gpt:5605",
    "gpt:632",
    "gpt:772",
    "gpt:783",
    "gpt:8",
    "gpt:888",
    "gpt:922",
    "gpt:988",
}


def check_mandate_draft_checkout_constraints_item_type_2_allow_item(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType2AllowItem:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_ALLOW_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_ALLOW_ITEM_VALUES!r}"
    )
