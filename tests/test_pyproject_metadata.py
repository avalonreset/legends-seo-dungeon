"""Packaging metadata and lint-config guards."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_has_authors_and_keywords() -> None:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'authors = [' in text
    assert 'name = "Avalon Reset"' in text
    assert 'email = "avalonreset@users.noreply.github.com"' in text
    for keyword in ("seo", "codex", "schema-markup", "core-web-vitals", "ai-search"):
        assert f'"{keyword}"' in text


def test_pyproject_has_minimal_ruff_config_only() -> None:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "[tool.ruff]" in text
    assert 'target-version = "py311"' in text
    assert "line-length = 100" in text
    assert "[tool.ruff.lint]" in text
    assert 'select = ["E", "F", "W", "I"]' in text
    assert 'ignore = ["E501"]' in text


def test_requirements_accept_selected_security_compatibility_floors() -> None:
    text = (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r"^lxml>=6\.1\.1,<7\.0\.0", text, re.MULTILINE)
    assert re.search(r"^lxml_html_clean>=0\.4\.3,<1\.0\.0", text, re.MULTILINE)
    assert re.search(r"^urllib3>=2\.7\.0,<3\.0\.0", text, re.MULTILINE)
    assert re.search(r"^numpy>=1\.26\.0,<3\.0\.0", text, re.MULTILINE)
    assert re.search(r"^google-auth-httplib2>=0\.4\.0,<1\.0\.0", text, re.MULTILINE)
    assert re.search(r"^google-ads>=25\.0\.0,<40\.0\.0", text, re.MULTILINE)
