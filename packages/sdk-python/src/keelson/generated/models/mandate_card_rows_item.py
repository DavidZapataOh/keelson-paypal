from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.mandate_card_rows_item_answers import (
    MandateCardRowsItemAnswers,
    check_mandate_card_rows_item_answers,
)
from ..models.mandate_card_rows_item_color import (
    MandateCardRowsItemColor,
    check_mandate_card_rows_item_color,
)

T = TypeVar("T", bound="MandateCardRowsItem")


@_attrs_define
class MandateCardRowsItem:
    """
    Attributes:
        field (str):
        label (str):
        values (list[str]):
        color (MandateCardRowsItemColor):
        answers (MandateCardRowsItemAnswers):
    """

    field: str
    label: str
    values: list[str]
    color: MandateCardRowsItemColor
    answers: MandateCardRowsItemAnswers
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        field = self.field

        label = self.label

        values = self.values

        color: str = self.color

        answers: str = self.answers

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "field": field,
                "label": label,
                "values": values,
                "color": color,
                "answers": answers,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        field = d.pop("field")

        label = d.pop("label")

        values = cast(list[str], d.pop("values"))

        color = check_mandate_card_rows_item_color(d.pop("color"))

        answers = check_mandate_card_rows_item_answers(d.pop("answers"))

        mandate_card_rows_item = cls(
            field=field,
            label=label,
            values=values,
            color=color,
            answers=answers,
        )

        mandate_card_rows_item.additional_properties = d
        return mandate_card_rows_item

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
