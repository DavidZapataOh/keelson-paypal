from __future__ import annotations

import inspect
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import keelson

ROOT = Path(__file__).resolve().parents[1]


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _surface(client: keelson.AsyncKeelson) -> list[str]:
    out = [n for n, _ in inspect.getmembers(type(client), inspect.isfunction) if not n.startswith("_")]
    for name, value in vars(client).items():
        if name.startswith("_"):
            continue
        out += [f"{name}.{m}" for m, _ in inspect.getmembers(type(value), inspect.isfunction) if not m.startswith("_")]
    return sorted(set(out) - {"aclose"})


def test_every_typescript_method_has_a_python_twin() -> None:
    ts = json.loads((ROOT.parent / "sdk" / "api-surface.json").read_text())
    expected = sorted(".".join(_snake(p) for p in m.split(".")) for m in ts)
    assert _surface(keelson.AsyncKeelson(None)) == expected


def test_the_quickstart_is_at_most_12_lines() -> None:
    lines = [line for line in (ROOT / "examples" / "quickstart.py").read_text().splitlines() if line.strip()]
    assert len(lines) <= 12


def test_verify_without_node_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEELSON_VERIFY_COMMAND", "/nonexistent/keelson-verify")
    with pytest.raises(keelson.VerifierUnavailable, match="npx @keelson/verifier"):
        keelson.verify_alibi(b"{}")


@pytest.mark.skipif(sys.platform == "win32", reason="uses uv build")
def test_the_wheel_is_at_most_60_kb_with_two_dependencies(tmp_path: Path) -> None:
    subprocess.run(["uv", "build", "--wheel", "-q", "-o", str(tmp_path)], cwd=ROOT, check=True)
    wheel = next(tmp_path.glob("*.whl"))
    print(f"keelson-finance wheel: {wheel.stat().st_size} B")
    assert wheel.stat().st_size <= 60 * 1024
    with zipfile.ZipFile(wheel) as z:
        meta = next(n for n in z.namelist() if n.endswith("METADATA"))
        requires = [
            line.split(":", 1)[1].strip()
            for line in z.read(meta).decode().splitlines()
            if line.startswith("Requires-Dist:") and "extra ==" not in line
        ]
    assert sorted(re.split(r"[<>=; ]", r)[0] for r in requires) == ["httpx2", "pydantic"]


def test_verify_reports_a_broken_verifier_as_a_keelson_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEELSON_VERIFY_COMMAND", "echo not-json")
    with pytest.raises(keelson.KeelsonError):
        keelson.verify_alibi(b"{}")
