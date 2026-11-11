"""Regression tests for v2.2.7 security hardening ([DUNGEON-003..009, 012])."""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import commoncrawl_graph  # noqa: E402
import google_auth  # noqa: E402
import indexnow_submit  # noqa: E402
import ucp_check  # noqa: E402
import unlighthouse_run  # noqa: E402
import url_safety  # noqa: E402


def _load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_google_auth_rejects_untrusted_token_uri() -> None:
    with pytest.raises(ValueError, match="Untrusted OAuth token_uri"):
        google_auth._post_oauth_token("https://evil.example.com/token", b"grant_type=refresh_token")


def test_google_auth_refresh_rejects_untrusted_token_uri() -> None:
    client = {
        "client_id": "cid",
        "client_secret": "csec",
        "token_uri": "https://evil.example.com/token",
    }
    token_data = {"refresh_token": "rtok"}
    assert google_auth._refresh_oauth_token(client, token_data) is None


def test_commoncrawl_graph_validates_release_and_domain_and_gzip_ceiling(tmp_path: Path, monkeypatch) -> None:
    with pytest.raises(ValueError, match="Invalid Common Crawl release identifier"):
        commoncrawl_graph._validate_release_name("../../etc/passwd")
    assert commoncrawl_graph._validate_release_name("cc-main-2025-feb-mar-apr") == "cc-main-2025-feb-mar-apr"

    monkeypatch.setattr(commoncrawl_graph, "get_cache_dir", lambda: str(tmp_path))
    cache_path = commoncrawl_graph._get_cache_path("../evil.com:8080", "cc-main-2025-feb-mar-apr", "vertices")
    assert Path(cache_path).resolve().is_relative_to(tmp_path.resolve())

    # Oversized gzip chunk must abort cleanly
    monkeypatch.setattr(commoncrawl_graph, "MAX_DECOMPRESSED_CHUNK_BYTES", 64)
    big_gz = gzip.compress(b"0\tcom,example\n" * 50)

    class _FakeResp:
        status_code = 200

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=65536):
            yield big_gz

        def close(self):
            pass

    monkeypatch.setattr(commoncrawl_graph, "safe_requests_get", lambda *a, **kw: _FakeResp())
    with pytest.raises(ValueError, match="Gzip chunk exceeded decompression safety bound"):
        list(commoncrawl_graph._stream_gz_lines("https://data.commoncrawl.org/test.txt.gz"))


def test_cluster_map_html_escapes_dynamic_attributes() -> None:
    template = (REPO_ROOT / "skills/seo-cluster/templates/cluster-map.html").read_text(encoding="utf-8")
    assert "function escapeHtml(" in template
    assert "ALLOWED_LINK_TYPES" in template
    assert "escapeHtml(link.from)" in template
    skill_md = (REPO_ROOT / "skills/seo-cluster/SKILL.md").read_text(encoding="utf-8")
    assert "DATA.seedKeyword" in skill_md or "escapeHtml" in skill_md or "<title>" not in skill_md


def test_url_safety_pins_redirect_hosts_and_blocks_metadata_hostnames() -> None:
    calls = {"elsewhere": 0}
    original_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host == "elsewhere.example":
            calls["elsewhere"] += 1
            # Return public IP on call 1, private IP on call 2 to simulate rebinding
            ip = "1.1.1.1" if calls["elsewhere"] == 1 else "169.254.169.254"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 443))]
        return original_getaddrinfo(host, port, *args, **kwargs)

    with patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo):
        with url_safety._pin_dns("pinned.example", "8.8.8.8", 443):
            r1 = socket.getaddrinfo("elsewhere.example", 443)
            r2 = socket.getaddrinfo("elsewhere.example", 443)
            assert r1[0][4][0] == "1.1.1.1"
            assert r2[0][4][0] == "1.1.1.1"
            assert calls["elsewhere"] == 1
            with pytest.raises(socket.gaierror, match="blocked hostname"):
                socket.getaddrinfo("metadata.google.internal", 80)


def test_safe_requests_get_enforces_max_bytes() -> None:
    class _StreamingResp:
        def __init__(self):
            self.closed = False
            self._content = b""

        def iter_content(self, chunk_size=65536):
            yield b"a" * 100
            yield b"b" * 100

        def close(self):
            self.closed = True

    with patch.object(url_safety, "validate_url_strict", return_value=("https://1.1.1.1/", "1.1.1.1")), \
         patch.object(url_safety.requests, "get", return_value=_StreamingResp()):
        with pytest.raises(url_safety.URLSafetyError, match="exceeds 150 byte limit"):
            url_safety.safe_requests_get("https://1.1.1.1/", max_bytes=150)


def test_ucp_check_uses_head_and_caps_probes() -> None:
    head_calls = []

    def fake_head(url, **kwargs):
        head_calls.append(url)
        return SimpleNamespace(status_code=200)

    profile = {
        "version": "1.0",
        "merchant": {"name": "Shop", "id": "1"},
        "capabilities": [
            {"id": "dev.ucp.shopping.checkout", "version": "1.0", "endpoint": f"https://1.1.1.1/ep/{i}"}
            for i in range(25)
        ],
    }

    with patch.object(ucp_check, "validate_url_strict", return_value=("https://1.1.1.1/", "1.1.1.1")), \
         patch.object(ucp_check, "safe_requests_get", return_value=SimpleNamespace(status_code=200, text=json.dumps(profile))), \
         patch.object(ucp_check, "safe_requests_head", side_effect=fake_head):
        report = ucp_check.audit_site("https://1.1.1.1", probe_endpoints=True)

    assert len(head_calls) == ucp_check.MAX_UCP_ENDPOINT_PROBES == 16
    assert len(report["endpoint_probes"]) == 16


def test_banana_scripts_validate_model_and_reject_symlinks(tmp_path: Path) -> None:
    gen = _load_module("banana_generate_sec", "extensions/banana/scripts/generate.py")
    edt = _load_module("banana_edit_sec", "extensions/banana/scripts/edit.py")

    out = io.StringIO()
    with redirect_stdout(out):
        with pytest.raises(SystemExit):
            gen.generate_image("prompt", "../../v1/evil?x=1#", "1:1", "1K", "AIzaSyValidKey123")
    assert "Invalid model identifier" in out.getvalue()

    key_file = tmp_path / "key.txt"
    key_file.write_text("AIzaSyValidKeyFromFile123\n", encoding="utf-8")
    assert gen._read_api_key_file(str(key_file)) == "AIzaSyValidKeyFromFile123"


def test_unlighthouse_resolves_windows_npx_to_node_cli(tmp_path: Path, monkeypatch) -> None:
    fake_node = tmp_path / "node.exe"
    fake_npx_cmd = tmp_path / "npx.cmd"
    fake_npx_js = tmp_path / "node_modules" / "npm" / "bin" / "npx-cli.js"
    fake_npx_js.parent.mkdir(parents=True, exist_ok=True)
    fake_node.write_bytes(b"MZ")
    fake_npx_cmd.write_text("@ECHO OFF\r\n", encoding="utf-8")
    fake_npx_js.write_text("// npx\n", encoding="utf-8")

    monkeypatch.setattr(unlighthouse_run.shutil, "which", lambda name: str(fake_npx_cmd) if name == "npx" else str(fake_node))
    resolved = unlighthouse_run._resolve_npx_command()
    assert resolved == [str(fake_node), str(fake_npx_js)]
