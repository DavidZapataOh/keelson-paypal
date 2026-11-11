from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.merchant_evaluations_columns_item import (
    MerchantEvaluationsColumnsItem,
    check_merchant_evaluations_columns_item,
)

T = TypeVar("T", bound="MerchantEvaluations")


@_attrs_define
class MerchantEvaluations:
    """One row per mandate field per evaluation at this merchant: its countersigned purchases and the red-team campaigns'
    attacks. `failed` is 1 when the field's check failed.

        Attributes:
            columns (list[MerchantEvaluationsColumnsItem]):
            rows (list[list[float | None | str]]):
    """

    columns: list[MerchantEvaluationsColumnsItem]
    rows: list[list[float | str | None]]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        columns = []
        for columns_item_data in self.columns:
            columns_item: str = columns_item_data
            columns.append(columns_item)

        rows = []
        for rows_item_data in self.rows:
            rows_item = []
            for rows_item_item_data in rows_item_data:
                rows_item_item: float | str | None
                rows_item_item = rows_item_item_data
                rows_item.append(rows_item_item)

            rows.append(rows_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "columns": columns,
                "rows": rows,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        columns = []
        _columns = d.pop("columns")
        for columns_item_data in _columns:
            columns_item = check_merchant_evaluations_columns_item(columns_item_data)

            columns.append(columns_item)

        rows = []
        _rows = d.pop("rows")
        for rows_item_data in _rows:
            rows_item = []
            _rows_item = rows_item_data
            for rows_item_item_data in _rows_item:

                def _parse_rows_item_item(data: object) -> float | str | None:
                    if data is None:
                        return data
                    return cast(float | None | str, data)

                rows_item_item = _parse_rows_item_item(rows_item_item_data)

                rows_item.append(rows_item_item)

            rows.append(rows_item)

        merchant_evaluations = cls(
            columns=columns,
            rows=rows,
        )

        merchant_evaluations.additional_properties = d
        return merchant_evaluations

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
