#!/usr/bin/env python3
"""Release readiness, privacy, typography, and Windows Defender / EDR gate for legends-seo-dungeon."""

from __future__ import annotations

import json
import re
import struct
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = [
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "CITATION.cff",
    "SECURITY.md",
    "LICENSE",
    "LICENSE-CLAUDE-SEO",
    "pyproject.toml",
    "runtime-plugin.json",
    ".codex-plugin/plugin.json",
    "dungeon/package.json",
    "scripts/runtime.py",
    "scripts/consistency_check.py",
    "scripts/release_privacy_check.py",
]

EXCLUDED_DIRS = {
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "build",
    "dist",
    "node_modules",
    ".logs",
}

TEXT_SUFFIXES = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".html",
    ".css",
    ".md",
    ".toml",
    ".json",
    ".yml",
    ".yaml",
    ".cff",
    ".txt",
    ".sh",
}

PRIVATE_PATTERNS = [
    re.compile(r"100\.\d{1,3}\.\d{1,3}\.\d{1,3}"),
    re.compile(r"C:\\Users\\", re.IGNORECASE),
    re.compile(r"/Users/[A-Za-z0-9._-]+/"),
    re.compile(r"/home/(?!user\b|runner\b|ubuntu\b)[A-Za-z0-9._-]+/"),
    re.compile(r"\brccol\b", re.IGNORECASE),
    re.compile(r"\bglitchyglitch\b", re.IGNORECASE),
    re.compile(r"\bheroine-pro\b", re.IGNORECASE),
    re.compile(r"\brosewood\b", re.IGNORECASE),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{35}"),
]

MOJIBAKE_PATTERNS = [
    "\ufffd",
    "\u00e2\u20ac\u201c",
    "\u00e2\u20ac\u201d",
    "\u00e2\u20ac\u2122",
    "\u00e2\u20ac\u0153",
    "\u00c3\u00a9",
]

EDR_TRIGGER_PATTERNS = [
    re.compile(r"windowsHide\s*:\s*(?:true|false)"),
    re.compile(r"-EncodedCommand\b", re.IGNORECASE),
    re.compile(r"-ExecutionPolicy\s+Bypass\b", re.IGNORECASE),
    re.compile(r"WScript\.Shell", re.IGNORECASE),
    re.compile(r"CREATE_NO_WINDOW"),
    re.compile(r"STARTF_USESHOWWINDOW"),
    re.compile(r"Invoke-Expression\b", re.IGNORECASE),
    re.compile(r"FromBase64String\b", re.IGNORECASE),
    re.compile(
        r"""(?:python(?:3)?|py\s+-3|\$\{?CLAUDE_SEO_PYTHON\}?|\$\{?python_bin\}?|staged_python|sys\.executable)[^\n]*?\s-c\s+['"]"""
    ),
]

FORBIDDEN_SUFFIXES = {
    ".ps1",
    ".bat",
    ".cmd",
    ".vbs",
    ".wsf",
    ".hta",
    ".scr",
    ".ahk",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
}


def _iter_files() -> list[Path]:
    files: list[Path] = []
    for path in sorted(ROOT.rglob("*")):
        rel_parts = set(path.relative_to(ROOT).parts)
        if rel_parts & EXCLUDED_DIRS:
            continue
        if path.is_file():
            files.append(path)
    return files


def check_required_files() -> list[str]:
    issues: list[str] = []
    for rel in REQUIRED_FILES:
        if not (ROOT / rel).is_file():
            issues.append(f"Missing required file: {rel}")
    return issues


def check_no_ps1_files(files: list[Path]) -> list[str]:
    issues: list[str] = []
    for path in files:
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            issues.append(
                f"{path.relative_to(ROOT).as_posix()}: forbidden file extension {path.suffix.lower()}"
            )
    return issues


def check_image_metadata(files: list[Path]) -> list[str]:
    issues: list[str] = []
    for path in files:
        suf = path.suffix.lower()
        rel = path.relative_to(ROOT).as_posix()
        if suf == ".png":
            data = path.read_bytes()
            if data[:8] != b"\x89PNG\r\n\x1a\n":
                issues.append(f"{rel}: invalid PNG header")
                continue
            pos = 8
            while pos + 8 <= len(data):
                length = struct.unpack(">I", data[pos : pos + 4])[0]
                ctype = data[pos + 4 : pos + 8]
                if ctype in (b"tEXt", b"iTXt", b"zTXt", b"eXIf"):
                    issues.append(f"{rel}: PNG contains metadata chunk {ctype.decode('ascii')}")
                pos += 8 + length + 4
        elif suf == ".webp":
            data = path.read_bytes()
            if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                pos = 12
                while pos + 8 <= len(data):
                    fourcc = data[pos : pos + 4]
                    size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
                    if fourcc in (b"EXIF", b"XMP "):
                        issues.append(f"{rel}: WebP contains metadata chunk {fourcc.decode('ascii').strip()}")
                    pos += 8 + size + (size & 1)
    return issues


def check_version_sync() -> list[str]:
    issues: list[str] = []
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    py_ver = pyproject["project"]["version"]
    pkg_ver = json.loads((ROOT / "dungeon/package.json").read_text(encoding="utf-8"))["version"]
    rt_ver = json.loads((ROOT / "runtime-plugin.json").read_text(encoding="utf-8"))["version"]
    plug_ver = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    cff_text = (ROOT / "CITATION.cff").read_text(encoding="utf-8")
    cff_match = re.search(r"^version:\s*(\S+)\s*$", cff_text, flags=re.MULTILINE)
    cff_ver = cff_match.group(1) if cff_match else None

    for label, val in [
        ("dungeon/package.json", pkg_ver),
        ("runtime-plugin.json", rt_ver),
        (".codex-plugin/plugin.json", plug_ver),
        ("CITATION.cff", cff_ver),
    ]:
        if val != py_ver:
            issues.append(f"Version mismatch: pyproject.toml={py_ver} vs {label}={val}")

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if f"## [{py_ver}]" not in changelog:
        issues.append(f"CHANGELOG.md missing section for [{py_ver}]")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if f"version-{py_ver}-blue" not in readme:
        issues.append(f"README.md version badge does not match {py_ver}")
    return issues


def check_text_files(files: list[Path]) -> list[str]:
    issues: list[str] = []
    this_script = Path(__file__).resolve()
    for path in files:
        is_launcher = path.relative_to(ROOT).as_posix() == "bin/claude-seo"
        if path.suffix.lower() not in TEXT_SUFFIXES and not is_launcher:
            continue
        rel = path.relative_to(ROOT).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            issues.append(f"{rel}: invalid UTF-8 ({exc})")
            continue

        for ch in text:
            code = ord(ch)
            if (code < 32 and ch not in ("\r", "\n", "\t")) or code == 0x7F:
                issues.append(f"{rel}: contains ASCII control character 0x{code:02X}")
                break

        if "\u2014" in text:
            issues.append(f"{rel}: contains em-dash (U+2014)")
        if "\u2013" in text:
            issues.append(f"{rel}: contains en-dash (U+2013)")

        for bad in MOJIBAKE_PATTERNS:
            if bad in text:
                issues.append(f"{rel}: contains mojibake sequence {bad!r}")

        if path.resolve() == this_script:
            continue

        if not rel.startswith("tests/"):
            for pat in PRIVATE_PATTERNS:
                match = pat.search(text)
                if match:
                    issues.append(f"{rel}: private/internal pattern matched: {match.group(0)}")

            if path.suffix.lower() in {".py", ".js", ".mjs", ".cjs", ".sh"} or is_launcher:
                for edr in EDR_TRIGGER_PATTERNS:
                    match = edr.search(text)
                    if match:
                        issues.append(f"{rel}: EDR trigger pattern matched: {match.group(0)}")
    return issues


def main() -> int:
    files = _iter_files()
    issues = (
        check_required_files()
        + check_no_ps1_files(files)
        + check_image_metadata(files)
        + check_version_sync()
        + check_text_files(files)
    )
    if issues:
        for item in issues:
            print(f"FAIL: {item}", file=sys.stderr)
        print(f"Release checks: FAIL ({len(issues)} issues)", file=sys.stderr)
        return 1
    print("Release checks: PASS (0 issues)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
