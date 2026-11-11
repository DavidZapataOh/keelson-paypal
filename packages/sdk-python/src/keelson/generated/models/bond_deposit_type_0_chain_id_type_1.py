from typing import Literal

BondDepositType0ChainIdType1 = Literal[42161]

BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_1_VALUES: set[BondDepositType0ChainIdType1] = {
    42161,
}


def check_bond_deposit_type_0_chain_id_type_1(value: int) -> BondDepositType0ChainIdType1:
    if value in BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_DEPOSIT_TYPE_0_CHAIN_ID_TYPE_1_VALUES!r}"
    )
