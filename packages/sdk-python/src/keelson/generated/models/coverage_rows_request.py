from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.coverage_rows_request_filter_model import CoverageRowsRequestFilterModel
    from ..models.coverage_rows_request_sort_model_item import CoverageRowsRequestSortModelItem


T = TypeVar("T", bound="CoverageRowsRequest")


@_attrs_define
class CoverageRowsRequest:
    """AG Grid's `IServerSideGetRowsRequest`: the block, its sort and its filter model (text, number, date and set
    filters). Amounts are filtered in US dollars.

        Attributes:
            start_row (int):
            end_row (int):
            sort_model (list[CoverageRowsRequestSortModelItem] | Unset):
            filter_model (CoverageRowsRequestFilterModel | None | Unset):
    """

    start_row: int
    end_row: int
    sort_model: list[CoverageRowsRequestSortModelItem] | Unset = UNSET
    filter_model: CoverageRowsRequestFilterModel | Unset | None = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.coverage_rows_request_filter_model import CoverageRowsRequestFilterModel

        start_row = self.start_row

        end_row = self.end_row

        sort_model: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.sort_model, Unset):
            sort_model = []
            for sort_model_item_data in self.sort_model:
                sort_model_item = sort_model_item_data.to_dict()
                sort_model.append(sort_model_item)

        filter_model: dict[str, Any] | Unset | None
        if isinstance(self.filter_model, Unset):
            filter_model = UNSET
        elif isinstance(self.filter_model, CoverageRowsRequestFilterModel):
            filter_model = self.filter_model.to_dict()
        else:
            filter_model = self.filter_model

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "startRow": start_row,
                "endRow": end_row,
            }
        )
        if sort_model is not UNSET:
            field_dict["sortModel"] = sort_model
        if filter_model is not UNSET:
            field_dict["filterModel"] = filter_model

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.coverage_rows_request_filter_model import CoverageRowsRequestFilterModel
        from ..models.coverage_rows_request_sort_model_item import CoverageRowsRequestSortModelItem

        d = dict(src_dict)
        start_row = d.pop("startRow")

        end_row = d.pop("endRow")

        _sort_model = d.pop("sortModel", UNSET)
        sort_model: list[CoverageRowsRequestSortModelItem] | Unset = UNSET
        if _sort_model is not UNSET:
            sort_model = []
            for sort_model_item_data in _sort_model:
                sort_model_item = CoverageRowsRequestSortModelItem.from_dict(sort_model_item_data)

                sort_model.append(sort_model_item)

        def _parse_filter_model(data: object) -> CoverageRowsRequestFilterModel | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                filter_model_type_0 = CoverageRowsRequestFilterModel.from_dict(data)

                return filter_model_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(CoverageRowsRequestFilterModel | None | Unset, data)

        filter_model = _parse_filter_model(d.pop("filterModel", UNSET))

        coverage_rows_request = cls(
            start_row=start_row,
            end_row=end_row,
            sort_model=sort_model,
            filter_model=filter_model,
        )

        coverage_rows_request.additional_properties = d
        return coverage_rows_request

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
