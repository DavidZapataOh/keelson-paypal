from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.coverage_row import CoverageRow


T = TypeVar("T", bound="GetCoverageRowsResponse200")


@_attrs_define
class GetCoverageRowsResponse200:
    """
    Attributes:
        rows (list[CoverageRow]):
        row_count (int):
    """

    rows: list[CoverageRow]
    row_count: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rows = []
        for rows_item_data in self.rows:
            rows_item = rows_item_data.to_dict()
            rows.append(rows_item)

        row_count = self.row_count

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "rows": rows,
                "rowCount": row_count,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.coverage_row import CoverageRow

        d = dict(src_dict)
        rows = []
        _rows = d.pop("rows")
        for rows_item_data in _rows:
            rows_item = CoverageRow.from_dict(rows_item_data)

            rows.append(rows_item)

        row_count = d.pop("rowCount")

        get_coverage_rows_response_200 = cls(
            rows=rows,
            row_count=row_count,
        )

        get_coverage_rows_response_200.additional_properties = d
        return get_coverage_rows_response_200

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
