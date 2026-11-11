from typing import Literal

MandateDraftUserCredJwkKty = Literal["EC"]

MANDATE_DRAFT_USER_CRED_JWK_KTY_VALUES: set[MandateDraftUserCredJwkKty] = {
    "EC",
}


def check_mandate_draft_user_cred_jwk_kty(value: str) -> MandateDraftUserCredJwkKty:
    if value in MANDATE_DRAFT_USER_CRED_JWK_KTY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_USER_CRED_JWK_KTY_VALUES!r}"
    )
