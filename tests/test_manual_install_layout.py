"""Exercise a real install in an isolated home without downloading dependencies."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

try:
    import tomllib
except ImportError:
    tomllib = None

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def installed(tmp_path_factory):
    home = tmp_path_factory.mktemp("dungeon home with spaces")
    env = dict(os.environ, CODEX_HOME=str(home), SEO_DUNGEON_SKIP_DEPS="1")
    if os.name == "nt":
        command = [shutil.which("pwsh") or "powershell", "-NoProfile", "-File", str(ROOT / "install.ps1")]
    else:
        command = ["bash", str(ROOT / "install.sh")]
    proc = subprocess.run(command, cwd=home, env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return home


def test_installed_engine_contains_public_data_extensions_and_licenses(installed):
    engine = installed / "skills" / "seo"
    for rel in ("data/google-updates.json", "scripts/runtime.py", "scripts/seo_updates.py",
                "extensions/banana/scripts/generate.py", "runtime-plugin.json", "LICENSE-CLAUDE-SEO"):
        assert (engine / rel).read_bytes() == (ROOT / rel).read_bytes()
    assert len(list((installed / "agents").glob("*.toml"))) == 23
    proc = subprocess.run([sys.executable, str(engine / "scripts/runtime.py"), "doctor", "--json"],
                          cwd=installed, capture_output=True, text=True, timeout=20)
    status = json.loads(proc.stdout)
    assert status["plugin_version"] == "2.2.6"
    assert status["ready"] is False  # SKIP_DEPS must not claim an installed environment.


def test_installed_prompts_resolve_runtime_outside_checkout(installed):
    runtime = (installed / "skills/seo/scripts/runtime.py").as_posix()
    skill = (installed / "skills/seo-technical/SKILL.md").read_text(encoding="utf-8")
    assert f'python "{runtime}" run render_page.py' in skill
    for path in (installed / "agents").glob("*.toml"):
        if tomllib:
            tomllib.loads(path.read_text(encoding="utf-8"))
    technical = installed / "agents/seo-technical.toml"
    if tomllib:
        body = tomllib.loads(technical.read_text(encoding="utf-8"))["developer_instructions"]
        assert f'python "{runtime}" run sitemap_discovery.py' in body
