from typing import Literal

BondDepositType0Kind = Literal["authorization"]

BOND_DEPOSIT_TYPE_0_KIND_VALUES: set[BondDepositType0Kind] = {
    "authorization",
}


def check_bond_deposit_type_0_kind(value: str) -> BondDepositType0Kind:
    if value in BOND_DEPOSIT_TYPE_0_KIND_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_DEPOSIT_TYPE_0_KIND_VALUES!r}"
    )
