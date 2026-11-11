import pytest

from keelson import VerifierUnavailable, verify_alibi


def test_verify_alibi_without_the_verifier_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEELSON_VERIFY_COMMAND", "node -e 'process.exit(3)'")
    with pytest.raises(VerifierUnavailable):
        verify_alibi(b"{}")


def test_verify_alibi_with_a_missing_command_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KEELSON_VERIFY_COMMAND", "keelson-verify-not-installed")
    with pytest.raises(VerifierUnavailable):
        verify_alibi(b"{}")
