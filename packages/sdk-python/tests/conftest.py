import os
import shutil
from pathlib import Path

import pytest

_CLI = Path(__file__).resolve().parents[2] / "sdk" / "dist" / "cli.js"


@pytest.fixture(scope="session", autouse=True)
def reference_verifier() -> None:
    """Runs the verifier this checkout builds (`pnpm --filter @keelson/sdk build`) until the
    release the SDK pins is on npm."""
    if "KEELSON_VERIFY_COMMAND" not in os.environ and _CLI.exists() and shutil.which("node"):
        os.environ["KEELSON_VERIFY_COMMAND"] = f"node {_CLI}"
