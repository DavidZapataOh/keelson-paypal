from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.coverage_rows_request_filter_model_premium_bps_type_3_filter_type import (
    CoverageRowsRequestFilterModelPremiumBpsType3FilterType,
    check_coverage_rows_request_filter_model_premium_bps_type_3_filter_type,
)
from ..models.coverage_rows_request_filter_model_premium_bps_type_3_type import (
    CoverageRowsRequestFilterModelPremiumBpsType3Type,
    check_coverage_rows_request_filter_model_premium_bps_type_3_type,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="CoverageRowsRequestFilterModelPremiumBpsType3")


@_attrs_define
class CoverageRowsRequestFilterModelPremiumBpsType3:
    """
    Attributes:
        filter_type (CoverageRowsRequestFilterModelPremiumBpsType3FilterType):
        type_ (CoverageRowsRequestFilterModelPremiumBpsType3Type):
        date_from (None | str | Unset):
        date_to (None | str | Unset):
    """

    filter_type: CoverageRowsRequestFilterModelPremiumBpsType3FilterType
    type_: CoverageRowsRequestFilterModelPremiumBpsType3Type
    date_from: str | Unset | None = UNSET
    date_to: str | Unset | None = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        filter_type: str = self.filter_type

        type_: str = self.type_

        date_from: str | Unset | None
        if isinstance(self.date_from, Unset):
            date_from = UNSET
        else:
            date_from = self.date_from

        date_to: str | Unset | None
        if isinstance(self.date_to, Unset):
            date_to = UNSET
        else:
            date_to = self.date_to

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "filterType": filter_type,
                "type": type_,
            }
        )
        if date_from is not UNSET:
            field_dict["dateFrom"] = date_from
        if date_to is not UNSET:
            field_dict["dateTo"] = date_to

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        filter_type = check_coverage_rows_request_filter_model_premium_bps_type_3_filter_type(
            d.pop("filterType")
        )

        type_ = check_coverage_rows_request_filter_model_premium_bps_type_3_type(d.pop("type"))

        def _parse_date_from(data: object) -> str | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        date_from = _parse_date_from(d.pop("dateFrom", UNSET))

        def _parse_date_to(data: object) -> str | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        date_to = _parse_date_to(d.pop("dateTo", UNSET))

        coverage_rows_request_filter_model_premium_bps_type_3 = cls(
            filter_type=filter_type,
            type_=type_,
            date_from=date_from,
            date_to=date_to,
        )

        coverage_rows_request_filter_model_premium_bps_type_3.additional_properties = d
        return coverage_rows_request_filter_model_premium_bps_type_3

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
