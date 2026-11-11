from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.coverage_rows_request_filter_model_created_at_type_1_filter_type import (
    CoverageRowsRequestFilterModelCreatedAtType1FilterType,
    check_coverage_rows_request_filter_model_created_at_type_1_filter_type,
)
from ..models.coverage_rows_request_filter_model_created_at_type_1_type import (
    CoverageRowsRequestFilterModelCreatedAtType1Type,
    check_coverage_rows_request_filter_model_created_at_type_1_type,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="CoverageRowsRequestFilterModelCreatedAtType1")


@_attrs_define
class CoverageRowsRequestFilterModelCreatedAtType1:
    """
    Attributes:
        filter_type (CoverageRowsRequestFilterModelCreatedAtType1FilterType):
        type_ (CoverageRowsRequestFilterModelCreatedAtType1Type):
        filter_ (None | str | Unset):
    """

    filter_type: CoverageRowsRequestFilterModelCreatedAtType1FilterType
    type_: CoverageRowsRequestFilterModelCreatedAtType1Type
    filter_: str | Unset | None = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        filter_type: str = self.filter_type

        type_: str = self.type_

        filter_: str | Unset | None
        if isinstance(self.filter_, Unset):
            filter_ = UNSET
        else:
            filter_ = self.filter_

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "filterType": filter_type,
                "type": type_,
            }
        )
        if filter_ is not UNSET:
            field_dict["filter"] = filter_

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        filter_type = check_coverage_rows_request_filter_model_created_at_type_1_filter_type(
            d.pop("filterType")
        )

        type_ = check_coverage_rows_request_filter_model_created_at_type_1_type(d.pop("type"))

        def _parse_filter_(data: object) -> str | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        filter_ = _parse_filter_(d.pop("filter", UNSET))

        coverage_rows_request_filter_model_created_at_type_1 = cls(
            filter_type=filter_type,
            type_=type_,
            filter_=filter_,
        )

        coverage_rows_request_filter_model_created_at_type_1.additional_properties = d
        return coverage_rows_request_filter_model_created_at_type_1

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
