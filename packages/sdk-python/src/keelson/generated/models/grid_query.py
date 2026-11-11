from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.grid_query_grid_state import GridQueryGridState
    from ..models.grid_query_schema import GridQuerySchema


T = TypeVar("T", bound="GridQuery")


@_attrs_define
class GridQuery:
    """
    Attributes:
        prompt (str):
        grid_state (GridQueryGridState):
        schema (GridQuerySchema): `gridApi.getStructuredSchema()`, the JSON Schema of grid state.
    """

    prompt: str
    grid_state: GridQueryGridState
    schema: GridQuerySchema
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        prompt = self.prompt

        grid_state = self.grid_state.to_dict()

        schema = self.schema.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "prompt": prompt,
                "gridState": grid_state,
                "schema": schema,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.grid_query_grid_state import GridQueryGridState
        from ..models.grid_query_schema import GridQuerySchema

        d = dict(src_dict)
        prompt = d.pop("prompt")

        grid_state = GridQueryGridState.from_dict(d.pop("gridState"))

        schema = GridQuerySchema.from_dict(d.pop("schema"))

        grid_query = cls(
            prompt=prompt,
            grid_state=grid_state,
            schema=schema,
        )

        grid_query.additional_properties = d
        return grid_query

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
