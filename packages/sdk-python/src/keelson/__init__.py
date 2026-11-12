"""Keelson for Python: let an AI agent spend within a mandate the user signs with a passkey."""

from ._agent_key import cart_hash, close_mandate, import_agent_key
from ._auth import (
    AUDIENCE,
    DEFAULT_BASE_URL,
    OPERATOR_SCOPES,
    AuthProvider,
    client_credentials,
    static_token,
)
from ._client import AsyncKeelson, Keelson
from ._credentials import (
    Credentials,
    credentials_path,
    read_credentials,
    resolve_auth,
    stored_login,
    write_credentials,
)
from ._errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    InternalServerError,
    KeelsonError,
    MandateRequestClosedError,
    NotFoundError,
    OutcomeUnknownError,
    PermissionDeniedError,
    RateLimitError,
    UnprocessableEntityError,
    VerifierUnavailable,
)
from ._jcs import canonical_bytes
from ._login import LOGIN_SCOPES, login
from ._money import minor_of
from ._sandbox import SANDBOX_STORE, quote
from ._seal import manifest_of, sealed_items
from ._tools import KeelsonTool, tools
from ._verify import verify_alibi
from .resources.events import ServerEvent
from .resources.mandates import Mandate, MandateRequest
from .resources.purchases import CountersignResult

__version__ = "0.1.2"

__all__ = [
    "AUDIENCE",
    "DEFAULT_BASE_URL",
    "LOGIN_SCOPES",
    "OPERATOR_SCOPES",
    "SANDBOX_STORE",
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APIError",
    "AsyncKeelson",
    "AuthProvider",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "CountersignResult",
    "Credentials",
    "InternalServerError",
    "Keelson",
    "KeelsonError",
    "KeelsonTool",
    "Mandate",
    "MandateRequest",
    "MandateRequestClosedError",
    "NotFoundError",
    "OutcomeUnknownError",
    "PermissionDeniedError",
    "RateLimitError",
    "ServerEvent",
    "UnprocessableEntityError",
    "VerifierUnavailable",
    "__version__",
    "canonical_bytes",
    "cart_hash",
    "client_credentials",
    "close_mandate",
    "credentials_path",
    "import_agent_key",
    "login",
    "manifest_of",
    "minor_of",
    "quote",
    "read_credentials",
    "resolve_auth",
    "sealed_items",
    "static_token",
    "stored_login",
    "tools",
    "verify_alibi",
    "write_credentials",
]
