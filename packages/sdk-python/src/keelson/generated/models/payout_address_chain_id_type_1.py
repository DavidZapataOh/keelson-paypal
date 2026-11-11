from typing import Literal

PayoutAddressChainIdType1 = Literal[42161]

PAYOUT_ADDRESS_CHAIN_ID_TYPE_1_VALUES: set[PayoutAddressChainIdType1] = {
    42161,
}


def check_payout_address_chain_id_type_1(value: int) -> PayoutAddressChainIdType1:
    if value in PAYOUT_ADDRESS_CHAIN_ID_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {PAYOUT_ADDRESS_CHAIN_ID_TYPE_1_VALUES!r}"
    )
