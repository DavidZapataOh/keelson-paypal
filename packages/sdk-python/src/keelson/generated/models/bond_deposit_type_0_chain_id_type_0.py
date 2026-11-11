from typing import Literal

BondDepositType0ChainIdType0 = Literal[421614]

BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_0_VALUES: set[BondDepositType0ChainIdType0] = {
    421614,
}


def check_bond_deposit_type_0_chain_id_type_0(value: int) -> BondDepositType0ChainIdType0:
    if value in BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_0_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_0_VALUES!r}"
    )
