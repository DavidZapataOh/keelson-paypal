from typing import Literal

CompiledMandateAmbiguousItem = Literal[
    "agent",
    "bond",
    "budget",
    "card",
    "category",
    "currency",
    "deadline",
    "items",
    "merchant",
    "mode",
    "quantity",
    "recurrence",
    "return_policy",
    "subjective",
    "summary",
    "total",
    "variant",
]

COMPILED_MANDATE_AMBIGUOUS_ITEM_VALUES: set[CompiledMandateAmbiguousItem] = {
    "agent",
    "bond",
    "budget",
    "card",
    "category",
    "currency",
    "deadline",
    "items",
    "merchant",
    "mode",
    "quantity",
    "recurrence",
    "return_policy",
    "subjective",
    "summary",
    "total",
    "variant",
}


def check_compiled_mandate_ambiguous_item(value: str) -> CompiledMandateAmbiguousItem:
    if value in COMPILED_MANDATE_AMBIGUOUS_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COMPILED_MANDATE_AMBIGUOUS_ITEM_VALUES!r}"
    )
