from typing import Literal

CompleteBondWithdrawalChainId = Literal["42161", "421614"]

COMPLETE_BOND_WITHDRAWAL_CHAIN_ID_VALUES: set[CompleteBondWithdrawalChainId] = {
    "42161",
    "421614",
}


def check_complete_bond_withdrawal_chain_id(value: str) -> CompleteBondWithdrawalChainId:
    if value in COMPLETE_BOND_WITHDRAWAL_CHAIN_ID_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COMPLETE_BOND_WITHDRAWAL_CHAIN_ID_VALUES!r}"
    )
