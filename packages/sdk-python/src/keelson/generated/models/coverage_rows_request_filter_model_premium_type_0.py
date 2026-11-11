from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.coverage_rows_request_filter_model_premium_type_0_filter_type import (
    CoverageRowsRequestFilterModelPremiumType0FilterType,
    check_coverage_rows_request_filter_model_premium_type_0_filter_type,
)
from ..models.coverage_rows_request_filter_model_premium_type_0_operator import (
    CoverageRowsRequestFilterModelPremiumType0Operator,
    check_coverage_rows_request_filter_model_premium_type_0_operator,
)

if TYPE_CHECKING:
    from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_0 import (
        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_1 import (
        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_2 import (
        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2,
    )


T = TypeVar("T", bound="CoverageRowsRequestFilterModelPremiumType0")


@_attrs_define
class CoverageRowsRequestFilterModelPremiumType0:
    """
    Attributes:
        filter_type (CoverageRowsRequestFilterModelPremiumType0FilterType):
        operator (CoverageRowsRequestFilterModelPremiumType0Operator):
        conditions (list[CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0 |
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1 |
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2]):
    """

    filter_type: CoverageRowsRequestFilterModelPremiumType0FilterType
    operator: CoverageRowsRequestFilterModelPremiumType0Operator
    conditions: list[
        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0
        | CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1
        | CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2
    ]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_0 import (
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_1 import (
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1,
        )

        filter_type: str = self.filter_type

        operator: str = self.operator

        conditions = []
        for conditions_item_data in self.conditions:
            conditions_item: dict[str, Any]
            if isinstance(
                conditions_item_data, CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0
            ) or isinstance(
                conditions_item_data, CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1
            ):
                conditions_item = conditions_item_data.to_dict()
            else:
                conditions_item = conditions_item_data.to_dict()

            conditions.append(conditions_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "filterType": filter_type,
                "operator": operator,
                "conditions": conditions,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_0 import (
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_1 import (
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_0_conditions_item_type_2 import (
            CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2,
        )

        d = dict(src_dict)
        filter_type = check_coverage_rows_request_filter_model_premium_type_0_filter_type(
            d.pop("filterType")
        )

        operator = check_coverage_rows_request_filter_model_premium_type_0_operator(
            d.pop("operator")
        )

        conditions = []
        _conditions = d.pop("conditions")
        for conditions_item_data in _conditions:

            def _parse_conditions_item(
                data: object,
            ) -> (
                CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0
                | CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1
                | CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2
            ):
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    conditions_item_type_0 = (
                        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0.from_dict(
                            data
                        )
                    )

                    return conditions_item_type_0
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    conditions_item_type_1 = (
                        CoverageRowsRequestFilterModelPremiumType0ConditionsItemType1.from_dict(
                            data
                        )
                    )

                    return conditions_item_type_1
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                conditions_item_type_2 = (
                    CoverageRowsRequestFilterModelPremiumType0ConditionsItemType2.from_dict(data)
                )

                return conditions_item_type_2

            conditions_item = _parse_conditions_item(conditions_item_data)

            conditions.append(conditions_item)

        coverage_rows_request_filter_model_premium_type_0 = cls(
            filter_type=filter_type,
            operator=operator,
            conditions=conditions,
        )

        coverage_rows_request_filter_model_premium_type_0.additional_properties = d
        return coverage_rows_request_filter_model_premium_type_0

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
