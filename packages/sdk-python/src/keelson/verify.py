"""Offline Alibi verification with Keelson's reference verifier.

The checks (the user's passkey, both TEE attestations and countersignatures, the Cedar policy
replay, log inclusion and witness cosignatures, RFC 3161 timestamps, zero-knowledge proofs and,
optionally, the on-chain anchor) are the ones verify.keelson.finance runs in the browser. They are
not reimplemented here: :func:`verify_alibi` runs the same code, the ``keelson-verify`` command of
``@keelson/sdk``, on this machine with Node.js 22 or later. Keelson's servers are not asked
anything.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict
from urllib.parse import quote

import rfc8785

from .client import KeelsonError
from .generated.client import AuthenticatedClient, Client

ALIBI_MEDIA_TYPE = "application/vnd.keelson.alibi.v1+json"

SDK_VERSION = "0.1.0"
"""The ``@keelson/sdk`` release whose verifier :func:`verify_alibi` runs by default."""

Verdict = Literal["verified", "verified-unanchored", "verified-offline", "failed", "incomplete"]
CheckStatus = Literal["pass", "fail", "undisclosed", "pending", "absent", "unreachable"]


class Check(TypedDict):
    id: str
    step: int
    status: CheckStatus
    reads: list[str]
    ms: float
    reason: NotRequired[str]
    blame: NotRequired[list[str]]
    detail: NotRequired[dict[str, str]]


class Report(TypedDict):
    verdict: Verdict
    checks: list[Check]
    mode: Literal["2of2", "degraded"]
    fields: list[dict[str, Any]]
    unbound: list[dict[str, Any]]
    changed: list[str]
    ms: float


class VerifierUnavailable(RuntimeError):
    """Node.js, or the verifier command, could not be run."""


def _command() -> list[str]:
    # KEELSON_VERIFY_COMMAND runs another build of the verifier, e.g. `node dist/cli.js`.
    custom = os.environ.get("KEELSON_VERIFY_COMMAND")
    if custom:
        return shlex.split(custom)
    if shutil.which("npx") is None:
        raise VerifierUnavailable("verify_alibi needs Node.js 22 or later (npx) on PATH")
    return ["npx", "--yes", "--package", f"@keelson/sdk@{SDK_VERSION}", "keelson-verify"]


def verify_alibi(
    alibi: bytes | str | Path | dict[str, Any],
    *,
    chain: bool = False,
    rpc: str | None = None,
    timeout: float = 120.0,
) -> Report:
    """Verifies an Alibi bundle, or its public receipt, on this machine.

    ``alibi`` is its JSON bytes or text, a path to it, or the parsed object. Without ``chain``
    nothing is read from any network and the verdict is at best ``verified-offline``; with it,
    the anchor on Arbitrum is read too (over ``rpc``, or the public RPCs) and the verdict is at
    best ``verified``. Every check passed only if the verdict starts with ``verified``.
    """
    if isinstance(alibi, Path):
        data = alibi.read_bytes()
    elif isinstance(alibi, dict):
        data = rfc8785.dumps(alibi)
    elif isinstance(alibi, str):
        data = alibi.encode()
    else:
        data = alibi
    args = [*_command(), *(["--chain"] if chain else []), *(["--rpc", rpc] if rpc else []), "-"]
    try:
        done = subprocess.run(args, input=data, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as err:
        raise VerifierUnavailable(f"cannot run {args[0]}: {err}") from err
    try:
        report: Report = json.loads(done.stdout)
    except ValueError:
        raise VerifierUnavailable(
            done.stderr.decode(errors="replace").strip()[-2000:] or "the verifier answered nothing"
        ) from None
    return report


def fetch_alibi(client: AuthenticatedClient | Client, purchase_id: str) -> bytes:
    """A purchase's Alibi bundle, as the exact bytes Keelson serves, to keep or verify."""
    # The bundle is read as bytes: a re-encoded copy would not be the canonical JSON it signs.
    response = client.get_httpx_client().get(
        f"/v1/alibis/{quote(purchase_id, safe='')}", headers={"accept": ALIBI_MEDIA_TYPE}
    )
    if not response.is_success:
        try:
            problem = response.json()
        except ValueError:
            problem = {}
        raise KeelsonError(response.status_code, problem if isinstance(problem, dict) else {})
    return response.content
