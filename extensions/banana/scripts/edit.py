#!/usr/bin/env python3
"""Claude Banana - Direct API Fallback: Image Editing

Edit images via Gemini REST API when MCP is unavailable.
Uses only Python stdlib (no pip dependencies).

Usage:
    edit.py --image path/to/image.png --prompt "remove the background"
            [--model MODEL] [--api-key-file PATH]
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
OUTPUT_DIR = Path.home() / "Documents" / "nanobanana_generated"
API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 25 * 1024 * 1024
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_API_KEY_VALUE_RE = re.compile(r"^[\x21-\x7e]{1,512}$")
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


def edit_image(image_path, prompt, model, api_key):
    """Call Gemini API to edit an image."""
    raw_img_path = Path(image_path)
    for candidate in (raw_img_path, *raw_img_path.parents):
        if candidate != raw_img_path and candidate in _MACOS_SYSTEM_SYMLINKS:
            continue
        try:
            if candidate.is_symlink():
                print(json.dumps({"error": True, "message": "Symlink image paths are not allowed"}))
                sys.exit(1)
        except OSError:
            pass
    image_path = raw_img_path.resolve()
    if not image_path.is_file():
        print(json.dumps({"error": True, "message": f"Image not found: {image_path}"}))
        sys.exit(1)
    if image_path.stat().st_size > MAX_IMAGE_BYTES:
        print(json.dumps({"error": True, "message": "Image exceeds 20 MiB size limit"}))
        sys.exit(1)

    model_id = model if model is not None else "gemini-2.5-flash-image"
    if not isinstance(model_id, str) or not _MODEL_ID_RE.match(model_id):
        print(json.dumps({"error": True, "message": "Invalid model identifier"}))
        sys.exit(1)
    if not isinstance(api_key, str) or not _API_KEY_VALUE_RE.match(api_key):
        print(json.dumps({"error": True, "message": "Invalid API key format"}))
        sys.exit(1)

    # Read and encode image
    with open(image_path, "rb") as f:
        raw_img_bytes = f.read(MAX_IMAGE_BYTES + 1)
    if len(raw_img_bytes) > MAX_IMAGE_BYTES:
        print(json.dumps({"error": True, "message": "Image exceeds 20 MiB size limit"}))
        sys.exit(1)
    image_b64 = base64.b64encode(raw_img_bytes).decode("utf-8")

    # Determine MIME type
    suffix = image_path.suffix.lower()
    mime_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                  ".webp": "image/webp", ".gif": "image/gif"}
    mime_type = mime_types.get(suffix, "image/png")

    url = f"{API_BASE}/{model_id}:generateContent"

    body = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {"inlineData": {"mimeType": mime_type, "data": image_b64}},
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
        },
    }

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
    filename = f"banana_edit_{timestamp}.png"
    output_path = (OUTPUT_DIR / filename).resolve()

    with open(output_path, "wb") as f:
        f.write(base64.b64decode(image_data))

    return {
        "path": str(output_path),
        "model": model,
        "source": str(image_path),
        "text": text_response,
    }


def main():
    parser = argparse.ArgumentParser(description="Edit images via Gemini REST API")
    parser.add_argument("--image", required=True, help="Path to input image")
    parser.add_argument("--prompt", required=True, help="Edit instruction")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model ID (or set NANOBANANA_MODEL env)")
    parser.add_argument("--api-key-file", default=None, help="Path to file containing Google AI API key")

    args = parser.parse_args()

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

    result = edit_image(
        image_path=args.image,
        prompt=args.prompt,
        model=args.model,
        api_key=api_key,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
