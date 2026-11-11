"""Static installer/runtime contract checks that do not mutate a real home."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_installers_delegate_to_managed_setup_without_global_pip() -> None:
    for name in ("install.sh", "scripts/runtime.py"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert "scripts/runtime.py" in text or "runtime.py" in text
        assert "setup" in text
        assert "pip install --user" not in text
        assert "SetEnvironmentVariable('PATH'" not in text
        assert "install_runtime_docs.py" in text


def test_launcher_is_executable_and_uses_safe_exec() -> None:
    launcher = ROOT / "bin/claude-seo"
    if __import__("os").name != "nt":
        assert launcher.stat().st_mode & 0o100
    text = launcher.read_text(encoding="utf-8")
    assert 'exec py -3 "${runtime}" "$@"' in text
    assert 'exec python3 "${runtime}" "$@"' in text
    assert 'exec python "${runtime}" "$@"' in text
    assert "eval " not in text
