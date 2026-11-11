from typing import Literal

PayoutAddressChainIdType0 = Literal[421614]

PAYOUT_ADDRESS_CHAIN_ID_TYPE_0_VALUES: set[PayoutAddressChainIdType0] = {
    421614,
}


def check_payout_address_chain_id_type_0(value: int) -> PayoutAddressChainIdType0:
    if value in PAYOUT_ADDRESS_CHAIN_ID_TYPE_0_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {PAYOUT_ADDRESS_CHAIN_ID_TYPE_0_VALUES!r}"
    )
