"""
Tests that ensure the plugin's manifest and user-visible docs claim
counts that match reality on disk.

Background: this guard exists because the v1.9.7 release process suffered
two distinct skill-count drift incidents in a single release window. The
first was caught by manual reconciliation (pre-Phase-A); the second slipped
through when PR #56 merged a 21st core skill but the canonical phrasing
locked in Phase A was not re-run. v1.9.8 closes the systemic gap.

Tests run via `pytest tests/` and are wired into `.github/workflows/ci.yml`.
"""
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGIN_JSON = REPO_ROOT / ".codex-plugin" / "plugin.json"
CITATION_CFF = REPO_ROOT / "CITATION.cff"


def _count_skill_dirs() -> int:
    """Count subdirectories of skills/ that contain a SKILL.md."""
    skills_dir = REPO_ROOT / "skills"
    return sum(
        1 for d in skills_dir.iterdir()
        if d.is_dir() and (d / "SKILL.md").is_file()
    )


def _count_agent_files() -> int:
    """Count agents/seo-*.md files."""
    agents_dir = REPO_ROOT / "agents"
    return sum(
        1 for f in agents_dir.iterdir()
        if f.is_file() and f.suffix == ".md" and f.name.startswith("seo-")
    )


def _extract_count(text: str, unit: str) -> int:
    """Find the first occurrence of 'N <unit>' in text and return N."""
    match = re.search(rf"(\d+)\s+{re.escape(unit)}", text)
    if not match:
        raise AssertionError(f"No '{unit}' count claim found in text")
    return int(match.group(1))


def test_plugin_json_skill_count_matches_disk():
    """plugin.json description's 'N sub-skills' claim must equal skills/ dir count."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    claimed = _extract_count(plugin["description"], "sub-skills")
    actual = _count_skill_dirs()
    assert claimed == actual, (
        f"plugin.json description claims {claimed} sub-skills "
        f"but disk has {actual}. "
        f"Update the description to match the new count."
    )


def test_plugin_json_description_fits_registry_limit():
    """plugin.json description must stay below the Codex plugin registry limit."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    assert len(plugin["description"]) < 500


def test_plugin_json_subagent_count_matches_disk():
    """plugin.json description's 'N sub-agents' claim must equal agents/ count."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    claimed = _extract_count(plugin["description"], "sub-agents")
    actual = _count_agent_files()
    assert claimed == actual, (
        f"plugin.json description claims {claimed} sub-agents "
        f"but disk has {actual}. "
        f"Update the description to match the new count."
    )


def test_canonical_phrasing_in_user_visible_docs():
    """README, CLAUDE.md, AGENTS.md must reference the canonical sub-skills count."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    canonical_count = _extract_count(plugin["description"], "sub-skills")
    target_phrase = f"{canonical_count} sub-skills"
    for filename in ["README.md", "AGENTS.md"]:
        path = REPO_ROOT / filename
        head = "\n".join(path.read_text(encoding="utf-8").splitlines()[:120])
        assert target_phrase in head, (
            f"{filename} does not reference '{target_phrase}' in its first "
            f"120 lines. Update it to match plugin.json's canonical phrasing."
        )


def test_version_triangulation():
    """plugin.json version must equal CITATION.cff version."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    citation_text = CITATION_CFF.read_text(encoding="utf-8")
    citation_match = re.search(r"^version:\s*(\S+)", citation_text, re.MULTILINE)
    assert citation_match, "CITATION.cff has no 'version:' line"
    plugin_version = plugin["version"]
    citation_version = citation_match.group(1)
    assert plugin_version == citation_version, (
        f"plugin.json version is {plugin_version} but CITATION.cff has "
        f"{citation_version}. They must match every release."
    )


def test_pyproject_version_matches_plugin_json():
    """pyproject.toml version must equal plugin.json version.

    Background: pyproject.toml drifted to 1.9.6 while plugin.json was at
    1.9.8. The original triangulation test only covered CITATION.cff,
    so pyproject.toml drift slipped past CI. This guard closes that gap.
    """
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    pyproject_text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    pyproject_match = re.search(
        r'^version\s*=\s*"([^"]+)"', pyproject_text, re.MULTILINE
    )
    assert pyproject_match, "pyproject.toml has no 'version = \"...\"' line"
    plugin_version = plugin["version"]
    pyproject_version = pyproject_match.group(1)
    assert plugin_version == pyproject_version, (
        f"plugin.json version is {plugin_version} but pyproject.toml has "
        f"{pyproject_version}. Bump pyproject.toml on every release."
    )


def test_install_scripts_default_to_current_source_with_ref_override():
    """Remote installs follow current source, independently of the game's tag.

    Engine and game versions follow the same public upstream release. Following
    main also includes Dungeon-specific fixes within that version. Both installers retain
    SEO_DUNGEON_REF for callers who explicitly choose a tag or branch.
    """
    sh_text = (REPO_ROOT / "install.sh").read_text(encoding="utf-8")
    sh_match = re.search(r'local ref="\$\{SEO_DUNGEON_REF:-([^}]+)\}"', sh_text)
    assert sh_match, "install.sh must preserve the source-ref override"
    assert sh_match.group(1) == "main", "install.sh must default to current source"

    runtime_text = (REPO_ROOT / "scripts" / "runtime.py").read_text(encoding="utf-8")
    py_match = re.search(
        r'os\.environ\.get\("SEO_DUNGEON_REF",\s*"([^"]+)"\)',
        runtime_text,
    )
    assert py_match, "scripts/runtime.py must preserve the source-ref override"
    assert py_match.group(1) == "main", "scripts/runtime.py must default to current source"


def _extract_section(text: str, heading: str) -> str:
    """Return the body of a `## <heading>` section, up to the next H2 heading or EOF."""
    pattern = rf"^## {re.escape(heading)}\b.*?(?=^## |\Z)"
    m = re.search(pattern, text, re.MULTILINE | re.DOTALL)
    return m.group(0) if m else ""


def test_orchestrator_sub_skills_list_matches_disk():
    """skills/seo/SKILL.md Sub-Skills numbered list must equal set(skills/*) minus orchestrator itself.

    Background: v1.9.8 CI guard checks README/CLAUDE/AGENTS but not the orchestrator's
    own canonical-phrasing source. PR #92 surfaced that the orchestrator had stale "21
    specialized" claims and the list included seo-firecrawl (extension-only). This
    guard closes that gap.
    """
    text = (REPO_ROOT / "skills" / "seo" / "SKILL.md").read_text(encoding="utf-8")
    section = _extract_section(text, "Sub-Skills")
    listed_list = re.findall(r"^\d+\.\s+\*\*(seo-[a-z-]+)\*\*", section, re.MULTILINE)
    assert len(listed_list) == len(set(listed_list)), (
        f"Duplicate entries in Sub-Skills list: "
        f"{[n for n in listed_list if listed_list.count(n) > 1]}"
    )
    listed = set(listed_list)
    on_disk = {
        d.name for d in (REPO_ROOT / "skills").iterdir()
        if d.is_dir() and (d / "SKILL.md").is_file()
    }
    # The orchestrator (`seo`) does not list itself.
    # seo-firecrawl is documented separately in an Optional Extensions subsection
    # because it lives only in extensions/, not in skills/.
    expected = on_disk - {"seo"}
    assert listed == expected, (
        f"Sub-Skills list != skills/ dir. "
        f"Missing from list: {sorted(expected - listed)}. "
        f"Extra in list: {sorted(listed - expected)}."
    )


def test_orchestrator_subagents_list_matches_disk():
    """skills/seo/SKILL.md Subagents bullet list must equal set(agents/seo-*.md), no duplicates.

    Background: same drift pattern as Sub-Skills. Codex round 3 review surfaced that
    the Subagents list was missing seo-flow (file on disk) and included seo-firecrawl
    (no agent file on disk).
    """
    text = (REPO_ROOT / "skills" / "seo" / "SKILL.md").read_text(encoding="utf-8")
    section = _extract_section(text, "Subagents")
    listed_list = re.findall(r"^- `(seo-[a-z-]+)`", section, re.MULTILINE)
    assert len(listed_list) == len(set(listed_list)), (
        f"Duplicate entries in Subagents list: "
        f"{[n for n in listed_list if listed_list.count(n) > 1]}"
    )
    listed = set(listed_list)
    on_disk = {
        p.stem for p in (REPO_ROOT / "agents").iterdir()
        if p.is_file() and p.suffix == ".md" and p.name.startswith("seo-")
    }
    assert listed == on_disk, (
        f"Subagents list != agents/ dir. "
        f"Missing from list: {sorted(on_disk - listed)}. "
        f"Extra in list: {sorted(listed - on_disk)}."
    )


def _extract_frontmatter(text: str) -> str:
    """Return the YAML frontmatter block (between the first two `---` lines).

    Returns the body between the delimiters (exclusive), or empty string if no
    frontmatter present. Scoping the regex search to this block prevents a
    fenced code example or later doc snippet from satisfying a metadata check.
    """
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    return m.group(1) if m else ""


def test_skill_metadata_versions_match_plugin_json():
    """Every SKILL.md metadata.version must equal plugin.json version (with community allowlist).

    Covers in-tree skills/*/SKILL.md and extension-mirror copies under
    extensions/*/skills/*/SKILL.md. Community contributions can be allowlisted
    to keep their own version cadence.

    Implementation note: parses the YAML frontmatter block specifically so that
    a fenced code example or later doc snippet showing `version: "x"` cannot
    satisfy the assertion after metadata.version has been removed from frontmatter.
    """
    # Community-contributed skills that maintain their own version cadence.
    # Each entry: skill name -> expected literal version string.
    COMMUNITY_OVERRIDES = {"seo-content-brief": "1.0.0"}

    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    expected_default = json.loads((REPO_ROOT / "runtime-plugin.json").read_text(encoding="utf-8"))["version"]
    errors = []

    candidates = list((REPO_ROOT / "skills").glob("*/SKILL.md")) + list(
        (REPO_ROOT / "extensions").glob("*/skills/*/SKILL.md")
    )
    for skill_md in candidates:
        skill_name = skill_md.parent.name
        rel = skill_md.relative_to(REPO_ROOT)
        text = skill_md.read_text(encoding="utf-8")
        frontmatter = _extract_frontmatter(text)
        if not frontmatter:
            errors.append(f"{rel} has no YAML frontmatter block")
            continue
        # metadata.version is nested under `metadata:` and indented by 2 spaces
        match = re.search(
            r'^  version:\s*"([^"]+)"', frontmatter, re.MULTILINE
        )
        if not match:
            errors.append(f"{rel} has no metadata.version in frontmatter")
            continue
        actual = match.group(1)
        expected = COMMUNITY_OVERRIDES.get(skill_name, expected_default)
        if actual != expected:
            errors.append(f"{rel}: version is {actual}, expected {expected}")

    assert not errors, "Skill metadata.version drift:\n  " + "\n  ".join(errors)


def test_codex_plugin_author_metadata_present():
    """Codex plugin metadata must carry complete author fields."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    p_author = plugin["author"]
    for field in ("name", "email", "url"):
        p_val = p_author.get(field)
        assert p_val, f"plugin.json author.{field} must be non-empty (was: {p_val!r})"


def test_canonical_math_adds_up():
    """The canonical phrasing's parenthetical breakdown must sum to the headline count."""
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    desc = plugin["description"]
    headline_match = re.search(r"(\d+)\s+sub-skills\s+\(([^)]+)\)", desc)
    assert headline_match, (
        "plugin.json description must use the canonical 'N sub-skills (...)' "
        "phrasing with a parenthetical breakdown"
    )
    headline = int(headline_match.group(1))
    breakdown = headline_match.group(2)
    parts = [int(n) for n in re.findall(r"(\d+)\s+(?:core|orchestrator|framework|extension)", breakdown)]
    assert sum(parts) == headline, (
        f"plugin.json canonical phrasing breakdown {breakdown!r} sums to "
        f"{sum(parts)} but headline claims {headline}. Math must add up."
    )


def test_reference_files_have_at_least_one_link():
    """Every skills/*/references/*.md file must be cited somewhere in the repo.

    Guards against orphan reference files - docs on disk that no SKILL.md,
    agent, top-level doc, or other reference file actually links to. Catches
    drift like the v2.0.0-era incident where llmstxt-evidence.md landed in
    references/ but was reachable only through a sibling cross-link, not
    through its parent SKILL.md.

    Cross-skill references are legitimate (e.g. skills/seo/references/
    backlink-quality.md is cited from seo-backlinks/SKILL.md) so the search
    is repo-wide rather than per-parent-skill.

    Searches the full filename (`name.md`) and the Obsidian-style wikilink
    form (`[[name]]`) across: every SKILL.md, every agent .md, every doc/*.md,
    top-level README/CHANGELOG/CLAUDE/AGENTS/CONTRIBUTING, and every other
    reference file. Each reference is excluded from its own search.
    """
    ref_files = list((REPO_ROOT / "skills").glob("*/references/*.md"))
    if not ref_files:
        return  # no references at all - nothing to check

    search_paths: list[Path] = []
    search_paths += list((REPO_ROOT / "skills").glob("*/SKILL.md"))
    search_paths += list((REPO_ROOT / "agents").glob("*.md"))
    search_paths += list((REPO_ROOT / "docs").glob("*.md"))
    for doc in ("README.md", "CHANGELOG.md", "CLAUDE.md",
                "AGENTS.md", "CONTRIBUTING.md"):
        candidate = REPO_ROOT / doc
        if candidate.exists():
            search_paths.append(candidate)
    # Reference files can cite each other (e.g. via [[wikilink]]).
    search_paths += ref_files

    text_by_path = {p: p.read_text(encoding="utf-8") for p in search_paths}

    orphans = []
    for ref in ref_files:
        slug = ref.stem  # 'llmstxt-evidence'
        filename = ref.name  # 'llmstxt-evidence.md'
        wikilink = f"[[{slug}]]"
        found = False
        for other_path, text in text_by_path.items():
            if other_path == ref:
                continue
            if filename in text or wikilink in text:
                found = True
                break
        if not found:
            orphans.append(str(ref.relative_to(REPO_ROOT)))

    assert not orphans, (
        "Orphan reference files (on disk, not cited anywhere repo-wide):\n  "
        + "\n  ".join(orphans)
        + "\n\nFix: link the file from its parent SKILL.md, a related "
          "reference doc, or a top-level doc - or delete if obsolete."
    )
