"""Connection settings shared by MCP and host configuration helpers."""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate_url(value: str) -> str:
    """Accept a Hub origin or a reverse-proxy base, without embedded credentials."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("TEAMHUB_URL must be an HTTP(S) base URL")
    base = value.rstrip("/")
    if base.endswith("/api/v1"):
        base = base[:-7]
    try:
        parsed = urlsplit(base)
        valid = (parsed.scheme in ("http", "https") and bool(parsed.hostname)
                 and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment
                 and not any(char.isspace() for char in base))
        _ = parsed.port
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("TEAMHUB_URL must be an HTTP(S) base without credentials, query or fragment")
    return base


def load_connection(url: str | None = None, token: str | None = None,
                    connection_file: str | Path | None = None) -> tuple[str, str | None]:
    """Read either one explicit connection file or environment settings.

    A connection file is authoritative for both URL and token. This prevents a
    stale inherited TEAMHUB_URL from sending that file's credential elsewhere.
    Explicit Python arguments remain available for tests and embedded callers.
    File paths and credentials are never included in configuration errors.
    """
    filename = connection_file or os.getenv("TEAMHUB_CONNECTION_FILE")
    if filename:
        try:
            path = Path(filename).expanduser()
            if path.stat().st_size > 64 * 1024:
                raise ValueError("oversized")
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if (not isinstance(data, dict) or not isinstance(data.get("url"), str)
                    or not isinstance(data.get("token"), str) or not data["token"].strip()):
                raise ValueError("missing fields")
        except (OSError, UnicodeError, ValueError):
            raise ValueError("Cannot read connection file; expected a private UTF-8 JSON object with url and token") from None
        base = url if url is not None else data["url"]
        secret = token if token is not None else data["token"]
    else:
        base = url if url is not None else os.getenv("TEAMHUB_URL", "http://127.0.0.1:8765")
        secret = token if token is not None else os.getenv("TEAMHUB_TOKEN")
    if secret is not None and (not isinstance(secret, str) or not secret.strip()
                               or "\r" in secret or "\n" in secret):
        raise ValueError("TEAMHUB_TOKEN must be a non-empty single-line value")
    return validate_url(base), secret
