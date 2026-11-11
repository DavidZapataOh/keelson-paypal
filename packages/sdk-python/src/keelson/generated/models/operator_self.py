from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.operator_self_operators_item import OperatorSelfOperatorsItem


T = TypeVar("T", bound="OperatorSelf")


@_attrs_define
class OperatorSelf:
    """
    Attributes:
        wallets (list[str]):
        operators (list[OperatorSelfOperatorsItem]):
    """

    wallets: list[str]
    operators: list[OperatorSelfOperatorsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        wallets = self.wallets

        operators = []
        for operators_item_data in self.operators:
            operators_item = operators_item_data.to_dict()
            operators.append(operators_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "wallets": wallets,
                "operators": operators,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operator_self_operators_item import OperatorSelfOperatorsItem

        d = dict(src_dict)
        wallets = cast(list[str], d.pop("wallets"))

        operators = []
        _operators = d.pop("operators")
        for operators_item_data in _operators:
            operators_item = OperatorSelfOperatorsItem.from_dict(operators_item_data)

            operators.append(operators_item)

        operator_self = cls(
            wallets=wallets,
            operators=operators,
        )

        operator_self.additional_properties = d
        return operator_self

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
