from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.coverage_rows_request_sort_model_item_col_id import (
    CoverageRowsRequestSortModelItemColId,
    check_coverage_rows_request_sort_model_item_col_id,
)
from ..models.coverage_rows_request_sort_model_item_sort import (
    CoverageRowsRequestSortModelItemSort,
    check_coverage_rows_request_sort_model_item_sort,
)

T = TypeVar("T", bound="CoverageRowsRequestSortModelItem")


@_attrs_define
class CoverageRowsRequestSortModelItem:
    """
    Attributes:
        col_id (CoverageRowsRequestSortModelItemColId):
        sort (CoverageRowsRequestSortModelItemSort):
    """

    col_id: CoverageRowsRequestSortModelItemColId
    sort: CoverageRowsRequestSortModelItemSort
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        col_id: str = self.col_id

        sort: str = self.sort

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "colId": col_id,
                "sort": sort,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        col_id = check_coverage_rows_request_sort_model_item_col_id(d.pop("colId"))

        sort = check_coverage_rows_request_sort_model_item_sort(d.pop("sort"))

        coverage_rows_request_sort_model_item = cls(
            col_id=col_id,
            sort=sort,
        )

        coverage_rows_request_sort_model_item.additional_properties = d
        return coverage_rows_request_sort_model_item

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
