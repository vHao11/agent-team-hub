"""Generate host-specific MCP configuration without reading or printing tokens.

Usage: python -m teamhub.harness_config --harness claude-code
Existing host configuration is never overwritten or silently merged.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PureWindowsPath
import re
import sys

from .connection import validate_url

HARNESSES = ("claude-code", "codex", "opencode", "opencode-v1", "generic")


def absolute_path(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value or "\n" in value or "\r" in value:
        raise ValueError(f"{label} must be an absolute filesystem path")
    if PureWindowsPath(value).is_absolute():
        return value
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute filesystem path")
    return str(path)


def render_config(harness: str, *, python: str | None = None,
                  url: str = "http://127.0.0.1:8765",
                  connection_file: str | None = None,
                  token_env: str = "TEAMHUB_TOKEN", name: str = "agent-team-hub") -> str:
    """Render a JSON/TOML fragment using each host's actual environment syntax.

    opencode targets V2; opencode-v1 explicitly targets the previous schema.
    Generic mcpServers clients use a connection-file argument because variable
    expansion and inherited environment filtering are not part of MCP itself.
    """
    if harness not in HARNESSES:
        raise ValueError(f"Unsupported harness; choose one of {', '.join(HARNESSES)}")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_env):
        raise ValueError("token_env must be an environment variable name")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", name):
        raise ValueError("Server name must contain only letters, digits, underscores or hyphens")
    command = absolute_path(python or sys.executable, "Python executable")
    base = validate_url(url)
    args = ["-m", "teamhub.mcp_server"]
    if connection_file:
        args += ["--connection-file", absolute_path(connection_file, "Connection file")]
    elif harness == "generic":
        raise ValueError("Generic clients require --connection-file; environment expansion differs by host")
    environment = {} if connection_file else {"TEAMHUB_URL": base}
    if harness == "codex":
        if not connection_file and token_env != "TEAMHUB_TOKEN":
            raise ValueError("Codex env_vars forwards the same name; use TEAMHUB_TOKEN or --connection-file")
        # JSON basic strings are also valid TOML basic strings for these values.
        encode = lambda value: json.dumps(value, ensure_ascii=False)
        lines = [f"[mcp_servers.{name}]", f"command = {encode(command)}", f"args = {encode(args)}"]
        if not connection_file:
            lines += ['env_vars = ["TEAMHUB_TOKEN"]', "", f"[mcp_servers.{name}.env]",
                      f"TEAMHUB_URL = {encode(base)}"]
        return "\n".join(lines) + "\n"
    if harness in ("opencode", "opencode-v1"):
        if not connection_file:
            environment["TEAMHUB_TOKEN"] = "{env:" + token_env + "}"
        server = {"type": "local", "command": [command, *args]}
        if environment:
            server["environment"] = environment
        mcp = {"servers": {name: server}} if harness == "opencode" else {name: server}
        result = {"$schema": "https://opencode.ai/config.json", "mcp": mcp}
    else:
        if not connection_file:
            environment["TEAMHUB_TOKEN"] = "${" + token_env + "}"
        server = {"command": command, "args": args}
        if harness == "claude-code":
            server["type"] = "stdio"
        if environment:
            server["env"] = environment
        result = {"mcpServers": {name: server}}
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harness", choices=HARNESSES, required=True)
    parser.add_argument("--python", default=sys.executable, help="Absolute Python executable with agent-team-hub[mcp] installed")
    parser.add_argument("--url", default="http://127.0.0.1:8765", help="Hub HTTP URL; connection-file mode uses the file URL")
    parser.add_argument("--connection-file", help="Absolute path to private JSON containing url and token")
    parser.add_argument("--token-env", default="TEAMHUB_TOKEN")
    parser.add_argument("--name", default="agent-team-hub")
    parser.add_argument("--output", help="Create a new config fragment; omit to print it")
    arguments = parser.parse_args()
    try:
        rendered = render_config(arguments.harness, python=arguments.python, url=arguments.url,
                                 connection_file=arguments.connection_file, token_env=arguments.token_env,
                                 name=arguments.name)
        if arguments.output:
            destination = Path(arguments.output).expanduser()
            destination.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(rendered)
            print(f"Created config fragment: {destination.resolve()}", file=sys.stderr)
        else:
            sys.stdout.write(rendered)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Configuration error: {error}\n")


if __name__ == "__main__":
    main()
