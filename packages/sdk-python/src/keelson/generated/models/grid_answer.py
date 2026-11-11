from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.grid_answer_grid_state import GridAnswerGridState


T = TypeVar("T", bound="GridAnswer")


@_attrs_define
class GridAnswer:
    """
    Attributes:
        grid_state (GridAnswerGridState):
        properties_to_ignore (list[str]):
        explanation (str):
        model (str):
        cost_micros (int): What the query cost, in USD micros.
    """

    grid_state: GridAnswerGridState
    properties_to_ignore: list[str]
    explanation: str
    model: str
    cost_micros: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        grid_state = self.grid_state.to_dict()

        properties_to_ignore = self.properties_to_ignore

        explanation = self.explanation

        model = self.model

        cost_micros = self.cost_micros

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "gridState": grid_state,
                "propertiesToIgnore": properties_to_ignore,
                "explanation": explanation,
                "model": model,
                "costMicros": cost_micros,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.grid_answer_grid_state import GridAnswerGridState

        d = dict(src_dict)
        grid_state = GridAnswerGridState.from_dict(d.pop("gridState"))

        properties_to_ignore = cast(list[str], d.pop("propertiesToIgnore"))

        explanation = d.pop("explanation")

        model = d.pop("model")

        cost_micros = d.pop("costMicros")

        grid_answer = cls(
            grid_state=grid_state,
            properties_to_ignore=properties_to_ignore,
            explanation=explanation,
            model=model,
            cost_micros=cost_micros,
        )

        grid_answer.additional_properties = d
        return grid_answer

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
