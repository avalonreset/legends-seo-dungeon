#!/usr/bin/env python3
"""Claude Banana - Direct API Fallback: Image Generation

Generate images via Gemini REST API when MCP is unavailable.
Uses only Python stdlib (no pip dependencies).

Usage:
    generate.py --prompt "a cat in space" [--aspect-ratio 16:9] [--resolution 1K]
                [--model MODEL] [--api-key-file PATH] [--thinking LEVEL] [--image-only]
"""

import argparse
import base64
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_MODEL = os.environ.get("NANOBANANA_MODEL")
DEFAULT_RESOLUTION = "1K"
DEFAULT_RATIO = "1:1"
OUTPUT_DIR = Path.home() / "Documents" / "nanobanana_generated"
API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_RESPONSE_BYTES = 25 * 1024 * 1024
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_API_KEY_VALUE_RE = re.compile(r"^[\x21-\x7e]{1,512}$")

VALID_RATIOS = {"1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2",
                "4:5", "5:4", "1:4", "4:1", "1:8", "8:1", "21:9"}
VALID_RESOLUTIONS = {"512", "1K", "2K", "4K"}
_GOOGLE_API_KEY_PREFIX = "AI" + "za"
_GOOGLE_API_KEY_RE = re.compile(_GOOGLE_API_KEY_PREFIX + r"[0-9A-Za-z_-]+")
_GOOGLE_KEY_QUERY_RE = re.compile(r"([?&])key=[^&\s'\"<>)]*(&?)")
_GOOGLE_KEY_BARE_RE = re.compile(r"\bkey=[^&\s'\"<>)]*")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, "Redirects are not allowed for authenticated API requests", headers, fp
        )


def _install_safe_opener():
    ctx = ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ctx),
        _NoRedirect(),
    )
    urllib.request.install_opener(opener)


_MACOS_SYSTEM_SYMLINKS = {
    Path("/var"),
    Path("/tmp"),
    Path("/etc"),
    Path("/private/var"),
    Path("/private/tmp"),
    Path("/private/etc"),
}


def _read_api_key_file(key_file_path):
    p = Path(key_file_path)
    for candidate in (p, *p.parents):
        if candidate != p and candidate in _MACOS_SYSTEM_SYMLINKS:
            continue
        try:
            if candidate.is_symlink():
                print(json.dumps({"error": True, "message": "Symlinks are not allowed for --api-key-file"}))
                sys.exit(1)
        except OSError:
            pass
    if not p.is_file():
        print(json.dumps({"error": True, "message": "API key file not found"}))
        sys.exit(1)
    if p.stat().st_size > 4096:
        print(json.dumps({"error": True, "message": "API key file exceeds 4 KiB size limit"}))
        sys.exit(1)
    raw = p.read_text(encoding="utf-8").strip()
    if not _API_KEY_VALUE_RE.match(raw):
        print(json.dumps({"error": True, "message": "Invalid API key format in --api-key-file"}))
        sys.exit(1)
    return raw


def _redact_google_api_key(value):
    """Remove Google API keys from standalone fallback error output."""
    text = str(value)

    def drop_query_key(match):
        separator, trailing_amp = match.groups()
        if separator == "?" and trailing_amp:
            return "?"
        if separator == "&" and trailing_amp:
            return "&"
        return ""

    text = _GOOGLE_KEY_QUERY_RE.sub(drop_query_key, text)
    text = text.replace("?&", "?")
    text = _GOOGLE_KEY_BARE_RE.sub("google_api_key_redacted", text)
    return _GOOGLE_API_KEY_RE.sub("GOOGLE_API_KEY_REDACTED", text)


def generate_image(prompt, model, aspect_ratio, resolution, api_key,
                   thinking_level=None, image_only=False):
    """Call Gemini API to generate an image."""
    model_id = model if model is not None else "gemini-2.5-flash-image"
    if not isinstance(model_id, str) or not _MODEL_ID_RE.match(model_id):
        print(json.dumps({"error": True, "message": "Invalid model identifier"}))
        sys.exit(1)
    if not isinstance(api_key, str) or not _API_KEY_VALUE_RE.match(api_key):
        print(json.dumps({"error": True, "message": "Invalid API key format"}))
        sys.exit(1)
    url = f"{API_BASE}/{model_id}:generateContent"

    modalities = ["IMAGE"] if image_only else ["TEXT", "IMAGE"]
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": modalities,
            "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": resolution,
            },
        },
    }

    if thinking_level:
        body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": thinking_level}

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key},
        method="POST",
    )

    _install_safe_opener()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            try:
                raw_resp = resp.read(MAX_RESPONSE_BYTES + 1)
            except TypeError:
                raw_resp = resp.read()
            if len(raw_resp) > MAX_RESPONSE_BYTES:
                print(json.dumps({"error": True, "message": "API response exceeds 25 MiB limit"}))
                sys.exit(1)
            result = json.loads(raw_resp.decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = _redact_google_api_key(
            e.read().decode("utf-8", "replace") if e.fp else ""
        )
        print(json.dumps({"error": True, "status": e.code, "message": error_body}))
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": True, "message": _redact_google_api_key(e.reason)}))
        sys.exit(1)

    # Extract image from response
    candidates = result.get("candidates", [])
    if not candidates:
        finish_reason = result.get("promptFeedback", {}).get("blockReason", "UNKNOWN")
        print(json.dumps({"error": True, "message": f"No candidates returned. Reason: {finish_reason}"}))
        sys.exit(1)

    parts = candidates[0].get("content", {}).get("parts", [])
    image_data = None
    text_response = ""

    for part in parts:
        if "inlineData" in part:
            image_data = part["inlineData"]["data"]
        elif "text" in part:
            text_response = part["text"]

    if not image_data:
        finish_reason = candidates[0].get("finishReason", "UNKNOWN")
        print(json.dumps({"error": True, "message": f"No image in response. finishReason: {finish_reason}"}))
        sys.exit(1)

    # Save image
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"banana_{timestamp}.png"
    output_path = (OUTPUT_DIR / filename).resolve()

    with open(output_path, "wb") as f:
        f.write(base64.b64decode(image_data))

    return {
        "path": str(output_path),
        "model": model,
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
        "text": text_response,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate images via Gemini REST API")
    parser.add_argument("--prompt", required=True, help="Image generation prompt")
    parser.add_argument("--aspect-ratio", default=DEFAULT_RATIO, help=f"Aspect ratio (default: {DEFAULT_RATIO})")
    parser.add_argument("--resolution", default=DEFAULT_RESOLUTION, help=f"Resolution: 512, 1K, 2K, 4K (default: {DEFAULT_RESOLUTION})")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model ID (or set NANOBANANA_MODEL env)")
    parser.add_argument("--api-key-file", default=None, help="Path to file containing Google AI API key")
    parser.add_argument("--thinking", default=None, choices=["minimal", "low", "medium", "high"], help="Thinking level")
    parser.add_argument("--image-only", action="store_true", help="Return image only (no text)")

    args = parser.parse_args()

    if args.aspect_ratio not in VALID_RATIOS:
        print(json.dumps({"error": True, "message": f"Invalid aspect ratio '{args.aspect_ratio}'. Valid: {sorted(VALID_RATIOS)}"}))
        sys.exit(1)

    if args.resolution not in VALID_RESOLUTIONS:
        print(json.dumps({"error": True, "message": f"Invalid resolution '{args.resolution}'. Valid: {sorted(VALID_RESOLUTIONS)}"}))
        sys.exit(1)

    if not args.model or not _MODEL_ID_RE.match(args.model):
        print(json.dumps({"error": True, "message": "No valid model. Set NANOBANANA_MODEL or pass --model."}))
        sys.exit(1)

    api_key = (
        (_read_api_key_file(args.api_key_file) if args.api_key_file else None)
        or os.environ.get("GOOGLE_AI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
    )
    if not api_key:
        print(json.dumps({"error": True, "message": "No API key. Set GOOGLE_AI_API_KEY env or pass --api-key-file"}))
        sys.exit(1)

    result = generate_image(
        prompt=args.prompt,
        model=args.model,
        aspect_ratio=args.aspect_ratio,
        resolution=args.resolution,
        api_key=api_key,
        thinking_level=args.thinking,
        image_only=args.image_only,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
