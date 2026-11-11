"""MCP agent permission and fail-closed regressions."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS = (
    ROOT / "agents" / "seo-dataforseo.md",
    ROOT / "extensions" / "dataforseo" / "agents" / "seo-dataforseo.md",
)


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_dataforseo_agent_mirrors_allow_direct_adapter_and_scoped_mcp():
    for path in AGENTS:
        text = _text(path)
        frontmatter = text.split("---", 2)[1]
        tools_line = next(line for line in frontmatter.splitlines() if line.startswith("tools:"))
        assert "mcp__dataforseo__*" in tools_line
        assert "Bash" in tools_line


def test_dataforseo_agent_mirrors_require_authorized_project_credentials():
    required = (
        "claude-seo run dataforseo_api.py",
        "If authorized project credentials are missing, skip the paid data call.",
        "print secret values or search unrelated credential stores.",
    )
    for path in AGENTS:
        text = _text(path)
        for phrase in required:
            assert phrase in text


def test_dataforseo_agent_bodies_stay_mirrored():
    public_body = _text(AGENTS[0]).split("---", 2)[2]
    extension_body = _text(AGENTS[1]).split("---", 2)[2]
    assert public_body == extension_body


def test_dataforseo_installers_use_matching_mcp_server_name():
    for rel in ("extensions/dataforseo/install.sh", "scripts/runtime.py"):
        text = _text(ROOT / rel)
        assert "['dataforseo']" in text or '["dataforseo"]' in text
