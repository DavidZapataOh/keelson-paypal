from typing import Literal

BondWithdrawalChainIdType1 = Literal[42161]

BOND_WITHDRAWAL_CHAIN_ID_TYPE_1_VALUES: set[BondWithdrawalChainIdType1] = {
    42161,
}


def check_bond_withdrawal_chain_id_type_1(value: int) -> BondWithdrawalChainIdType1:
    if value in BOND_WITHDRAWAL_CHAIN_ID_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_WITHDRAWAL_CHAIN_ID_TYPE_1_VALUES!r}"
    )
