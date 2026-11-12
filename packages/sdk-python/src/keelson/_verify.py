from __future__ import annotations

import base64
import json
import os
import shlex
import shutil
import subprocess
from collections.abc import Mapping
from typing import Any

from ._errors import KeelsonError, VerifierUnavailable
from ._jcs import canonical_bytes

VERIFIER = "@keelson-finance/verifier@0.1.2"


_NEEDS_NODE = f"Verifying an Alibi offline runs `npx {VERIFIER}`, which needs Node.js 20 or later."


def _check_node() -> None:
    """Refuses a missing or older Node.js before the verifier fails in a way that says less."""
    node = shutil.which("node")
    if node is None:
        raise VerifierUnavailable(_NEEDS_NODE)
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout
        major = int(version.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.TimeoutExpired) as err:
        raise VerifierUnavailable(_NEEDS_NODE) from err
    if major < 20:
        raise VerifierUnavailable(f"{_NEEDS_NODE} This machine has Node.js {version.strip()}.")


def _command() -> list[str]:
    if os.environ.get("KEELSON_VERIFY_COMMAND"):
        return shlex.split(os.environ["KEELSON_VERIFY_COMMAND"])
    _check_node()
    if shutil.which("keelson-verify"):
        return ["keelson-verify"]
    if shutil.which("npx"):
        return ["npx", "--yes", VERIFIER]
    raise VerifierUnavailable(f"Verifying an Alibi offline runs `npx {VERIFIER}`, which needs Node.js 20 or later.")


def verify_alibi(
    alibi: bytes | str | Mapping[str, Any], *, chain: bool = False, rpc_url: str | None = None
) -> dict[str, Any]:
    """Verifies an Alibi on this machine, trusting no one, with the same verifier as
    verify.keelson.finance: the TEE countersignatures, the evidence and the log inclusion proof.
    With ``chain``, it also reads the on-chain anchor; without, the verdict is at best
    ``verified-offline``. Returns the report: ``verdict``, ``checks``, ``mode``...
    """
    data = (
        (alibi.encode() if alibi.lstrip().startswith("{") else base64.b64decode(alibi))
        if isinstance(alibi, str)
        else bytes(alibi)
        if isinstance(alibi, bytes | bytearray)
        else canonical_bytes(dict(alibi))
    )
    args = [*_command(), "--json"]
    if rpc_url:
        args += ["--rpc", rpc_url]
    elif chain:
        args.append("--chain")
    try:
        done = subprocess.run([*args, "-"], input=data, capture_output=True, timeout=300, check=False)
    except subprocess.TimeoutExpired as err:
        raise KeelsonError("The verifier took more than 5 minutes.") from err
    except FileNotFoundError as err:
        raise VerifierUnavailable(
            f"Verifying an Alibi offline runs `npx {VERIFIER}`, which needs Node.js 20 or later."
        ) from err
    if done.returncode == 127 or not done.stdout.strip():
        if done.returncode in (126, 127):
            raise VerifierUnavailable(
                f"Verifying an Alibi offline runs `npx {VERIFIER}`, which needs Node.js 20 or later."
            )
        raise KeelsonError(f"The verifier failed: {done.stderr.decode().strip()[:500]}")
    try:
        report: dict[str, Any] = json.loads(done.stdout)
    except ValueError as err:
        raise KeelsonError(f"The verifier did not answer with a report: {done.stdout[:200]!r}") from err
    return report
