from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.operator_bond_bond import OperatorBondBond
    from ..models.operator_bond_reputation import OperatorBondReputation
    from ..models.operator_bond_validation import OperatorBondValidation


T = TypeVar("T", bound="OperatorBond")


@_attrs_define
class OperatorBond:
    """The operator's bond in PYUSD base units, the Keelson feedback it has in the ERC-8004 Reputation registry, and the
    TEE countersigns recorded for it in the Keelson validation registry.

        Attributes:
            bond (OperatorBondBond):
            reputation (OperatorBondReputation):
            validation (OperatorBondValidation):
    """

    bond: OperatorBondBond
    reputation: OperatorBondReputation
    validation: OperatorBondValidation
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        bond = self.bond.to_dict()

        reputation = self.reputation.to_dict()

        validation = self.validation.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "bond": bond,
                "reputation": reputation,
                "validation": validation,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operator_bond_bond import OperatorBondBond
        from ..models.operator_bond_reputation import OperatorBondReputation
        from ..models.operator_bond_validation import OperatorBondValidation

        d = dict(src_dict)
        bond = OperatorBondBond.from_dict(d.pop("bond"))

        reputation = OperatorBondReputation.from_dict(d.pop("reputation"))

        validation = OperatorBondValidation.from_dict(d.pop("validation"))

        operator_bond = cls(
            bond=bond,
            reputation=reputation,
            validation=validation,
        )

        operator_bond.additional_properties = d
        return operator_bond

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
