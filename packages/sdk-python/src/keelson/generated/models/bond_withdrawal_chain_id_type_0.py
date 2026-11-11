from typing import Literal

BondWithdrawalChainIdType0 = Literal[421614]

BOND_WITHDRAWAL_CHAIN_ID_TYPE_0_VALUES: set[BondWithdrawalChainIdType0] = {
    421614,
}


def check_bond_withdrawal_chain_id_type_0(value: int) -> BondWithdrawalChainIdType0:
    if value in BOND_WITHDRAWAL_CHAIN_ID_TYPE_0_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {BOND_WITHDRAWAL_CHAIN_ID_TYPE_0_VALUES!r}"
    )
