from typing import Literal

WebAuthnResponseType = Literal["public-key"]

WEB_AUTHN_RESPONSE_TYPE_VALUES: set[WebAuthnResponseType] = {
    "public-key",
}


def check_web_authn_response_type(value: str) -> WebAuthnResponseType:
    if value in WEB_AUTHN_RESPONSE_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {WEB_AUTHN_RESPONSE_TYPE_VALUES!r}"
    )
