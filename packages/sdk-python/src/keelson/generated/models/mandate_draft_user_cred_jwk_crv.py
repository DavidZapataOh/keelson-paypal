from typing import Literal

MandateDraftUserCredJwkCrv = Literal["P-256"]

MANDATE_DRAFT_USER_CRED_JWK_CRV_VALUES: set[MandateDraftUserCredJwkCrv] = {
    "P-256",
}


def check_mandate_draft_user_cred_jwk_crv(value: str) -> MandateDraftUserCredJwkCrv:
    if value in MANDATE_DRAFT_USER_CRED_JWK_CRV_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_USER_CRED_JWK_CRV_VALUES!r}"
    )
