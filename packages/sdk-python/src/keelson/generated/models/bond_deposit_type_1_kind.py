from typing import Literal

BondDepositType1Kind = Literal["permit"]

BOND_DEPOSIT_TYPE_1_KIND_VALUES: set[BondDepositType1Kind] = {
    "permit",
}


def check_bond_deposit_type_1_kind(value: str) -> BondDepositType1Kind:
    if value in BOND_DEPOSIT_TYPE_1_KIND_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_DEPOSIT_TYPE_1_KIND_VALUES!r}"
    )
