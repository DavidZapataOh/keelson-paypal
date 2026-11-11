"""Keelson's API for Python: a client generated from its OpenAPI document, OAuth helpers, the
agent flow with the MCP tools' envelope, and offline Alibi verification."""

from .agent import Envelope, KeelsonAgent, Next, Status
from .auth import (
    DELEGATED_SCOPES,
    KEELSON_API,
    AuthorizationRequest,
    BearerAuth,
    ClientCredentials,
    OAuthError,
    StaticToken,
    TokenProvider,
    TokenSet,
    UserTokens,
    create_authorization_request,
    exchange_code,
    register_public_client,
)
from .client import (
    AsyncKeelsonTransport,
    KeelsonError,
    KeelsonTransport,
    Retry,
    create_client,
    unwrap,
)
from .evidence import Cart, CartLine, Manifest, SealedItem, build_manifest, cart_hash, seal
from .mandate import close_mandate, import_agent_key
from .verify import Report, VerifierUnavailable, fetch_alibi, verify_alibi

__all__ = [
    "DELEGATED_SCOPES",
    "KEELSON_API",
    "AsyncKeelsonTransport",
    "AuthorizationRequest",
    "BearerAuth",
    "Cart",
    "CartLine",
    "ClientCredentials",
    "Envelope",
    "KeelsonAgent",
    "KeelsonError",
    "KeelsonTransport",
    "Manifest",
    "Next",
    "OAuthError",
    "Report",
    "Retry",
    "SealedItem",
    "StaticToken",
    "Status",
    "TokenProvider",
    "TokenSet",
    "UserTokens",
    "VerifierUnavailable",
    "build_manifest",
    "cart_hash",
    "close_mandate",
    "create_authorization_request",
    "create_client",
    "exchange_code",
    "fetch_alibi",
    "import_agent_key",
    "register_public_client",
    "seal",
    "unwrap",
    "verify_alibi",
]
