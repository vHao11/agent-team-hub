"""Verify generated MCP configs in real local harnesses, without model calls.

Run using the project's Python environment with the mcp extra installed.
Only temporary host profiles, Hub data and test identities are used. Host
executables must already be installed; this script never installs or upgrades
the user's harness. See docs/harness-host-verification.md.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "server"))
from teamhub.harness_config import render_config  # noqa: E402

NAME = "agent-team-hub"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def redact(value: str) -> str:
    return re.sub(r"(?i)(server password|token=|bearer\s+)\s*\S+", r"\1 <redacted>", value)


def run(args: list[str], directory: Path, env: dict[str, str], timeout: int = 45) -> str:
    result = subprocess.run(args, cwd=directory, env=env, text=True,
                            capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(redact(f"Host command failed ({result.returncode}): {result.stderr[-1500:]}"))
    return result.stdout


def stop(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    if child.stdin:
        child.stdin.close()
    else:
        child.terminate()
    try:
        child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def environment(directory: Path) -> dict[str, str]:
    # Only OS settings are inherited. No model credentials, personal MCP
    # variables or host-specific configuration are copied from the caller.
    allowed = {"path", "home", "userprofile", "systemroot", "windir", "comspec",
               "pathext", "tmp", "temp", "tmpdir", "lang", "lc_all",
               "ssl_cert_file", "ssl_cert_dir", "node_extra_ca_certs"}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    # These are each application's supported configuration/data locations,
    # scoped to subprocesses only; the invoking shell is never changed.
    env.update({"CLAUDE_CONFIG_DIR": str(directory / "claude-config"),
                "CODEX_HOME": str(directory / "codex-config"),
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
        env[key] = str(directory / key.lower())
    return env


def check_claude(executable: str, directory: Path, env: dict[str, str], connection: Path) -> dict:
    workspace = directory / "claude-project"
    workspace.mkdir()
    (workspace / ".mcp.json").write_text(render_config("claude-code", python=sys.executable,
        connection_file=str(connection)), encoding="utf-8")
    config = Path(env["CLAUDE_CONFIG_DIR"])
    config.mkdir()
    # Approve only this test server in the temporary user settings. Real user
    # project trust and MCP approval settings remain entirely untouched.
    (config / "settings.json").write_text(json.dumps({"enabledMcpjsonServers": [NAME]}))
    version = run([executable, "--version"], workspace, env).strip()
    output = run([executable, "mcp", "list"], workspace, env)
    line = next((line for line in output.splitlines() if line.startswith(NAME + ":")), "")
    if "Connected" not in line:
        raise RuntimeError("Claude Code did not report the test MCP server as Connected")
    return {"host": "claude-code", "version": version, "config": "passed",
            "mcp_connection": "passed", "tool_call": "not_checked_by_host_cli"}


def check_opencode(executable: str, directory: Path, env: dict[str, str], connection: Path) -> dict:
    workspace = directory / "opencode-project"
    workspace.mkdir()
    (workspace / "opencode.json").write_text(render_config("opencode", python=sys.executable,
        connection_file=str(connection)), encoding="utf-8")
    version = run([executable, "--version"], workspace, env).strip()
    if not re.search(r"\b(?:v)?2\.", version):
        raise RuntimeError("This host probe uses OpenCode V2. Supply a V2 executable.")
    env = {**env, "OPENCODE_PASSWORD": secrets.token_urlsafe(32)}
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    with (directory / "opencode.log").open("w", encoding="utf-8") as log:
        child = subprocess.Popen([executable, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=workspace, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(trust_env=False, timeout=2, auth=("opencode", env["OPENCODE_PASSWORD"])) as http:
                for _ in range(100):
                    if child.poll() is not None:
                        raise RuntimeError("The temporary OpenCode server exited during startup")
                    try:
                        if http.get(url + "/api/info").is_success:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError("The temporary OpenCode server did not start")
            # V2.2.7 has a cold-location race: its first mcp list can return an
            # empty registry before asynchronous MCP registration completes.
            # Reuse one server and wait for the actual connected status.
            for attempt in range(30):
                output = run([executable, "mcp", "list", "--server", url], workspace, env, timeout=15)
                line = next((line for line in output.splitlines() if NAME in line), "")
                if re.search(r"\bconnected\b", line, re.IGNORECASE):
                    break
                if "failed" in line.lower():
                    raise RuntimeError("OpenCode reported a failed MCP connection")
                time.sleep(.2)
            else:
                raise RuntimeError("OpenCode did not register and connect the test MCP server")
        finally:
            stop(child)
    return {"host": "opencode-v2", "version": version, "config": "passed",
            "mcp_connection": "passed", "status_attempts": attempt + 1,
            "tool_call": "not_checked_by_host_cli"}


class CodexRpc:
    def __init__(self, child: subprocess.Popen):
        self.child = child
        self.messages: queue.Queue = queue.Queue()
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self) -> None:
        for line in self.child.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                continue
        self.messages.put(None)

    def notify(self, method: str, params: dict) -> None:
        self.child.stdin.write(json.dumps({"method": method, "params": params}) + "\n")
        self.child.stdin.flush()

    def request(self, method: str, params: dict, timeout: int = 45) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self.child.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
        self.child.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Codex {method} did not finish before its timeout")
            try:
                message = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                raise RuntimeError(f"Codex {method} did not finish before its timeout") from None
            if message is None:
                raise RuntimeError(f"Codex exited while waiting for {method}")
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(redact(f"Codex {method}: {message['error']}"))
            return message["result"]


def check_codex(executable: str, directory: Path, env: dict[str, str], connection: Path,
                call_tool: bool = False) -> dict:
    workspace = directory / "codex-project"
    workspace.mkdir()
    config = Path(env["CODEX_HOME"])
    config.mkdir()
    (config / "config.toml").write_text(render_config("codex", python=sys.executable,
        connection_file=str(connection)), encoding="utf-8")
    version = run([executable, "--version"], workspace, env).strip()
    parsed = json.loads(run([executable, "mcp", "get", NAME, "--json"], workspace, env))
    if parsed.get("transport", {}).get("command") != sys.executable:
        raise RuntimeError("Codex did not read the generated stdio configuration")
    with (directory / "codex.log").open("w", encoding="utf-8") as log:
        child = subprocess.Popen([executable, "app-server", "--stdio"], cwd=workspace,
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            text=True, bufsize=1)
        rpc = CodexRpc(child)
        try:
            rpc.request("initialize", {"clientInfo": {"name": "teamhub_harness_check", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True}})
            rpc.notify("initialized", {})
            inventory = rpc.request("mcpServerStatus/list", {"serverName": NAME, "detail": "toolsAndAuthOnly"})
            found = next((value for value in inventory["data"] if value["name"] == NAME), None)
            if not found or not found.get("serverCapabilities") or found.get("toolsError"):
                raise RuntimeError("Codex did not initialize the MCP server")
            names = {tool["name"] for tool in found["tools"].values()}
            expected = {"hub_context", "ledger_review", "catalog_publish_release", "team_toolset_get"}
            if not expected <= names:
                raise RuntimeError("Codex discovered an incomplete Team Hub tool catalog")
            if call_tool:
                # Creating an ephemeral thread initializes local tools. No turn
                # is started. This requires the host's sandbox helper to work;
                # restricted containers may only support discovery above.
                thread = rpc.request("thread/start", {"cwd": str(workspace), "ephemeral": True})
                result = rpc.request("mcpServer/tool/call", {"threadId": thread["thread"]["id"],
                    "server": NAME, "tool": "hub_context", "arguments": {}})
                if result.get("isError"):
                    raise RuntimeError("Codex's actual MCP tool call returned an error")
                context = result.get("structuredContent")
                if not isinstance(context, dict) or "me" not in context:
                    context = next((json.loads(block["text"]) for block in result["content"]
                        if block.get("type") == "text"), {})
                if context.get("me", {}).get("id") != "u-lin":
                    raise RuntimeError("Codex's MCP call did not reach the authenticated demo Hub")
        finally:
            stop(child)
    return {"host": "codex", "version": version, "config": "passed",
            "mcp_connection": "passed", "discovered_tools": len(names),
            "tool_call": "hub_context passed" if call_tool else "not_requested",
            **({"actor_id": "u-lin"} if call_tool else {})}


def binary(explicit: str | None, runtime: Path | None, name: str) -> str:
    if explicit:
        path = Path(explicit).resolve()
    elif runtime and platform.system() == "Linux" and platform.machine() in ("x86_64", "AMD64"):
        paths = {"claude": "@anthropic-ai/claude-code-linux-x64/claude",
                 "opencode": "@opencode/cli-linux-x64/bin/opencode"}
        path = runtime.resolve() / "node_modules" / paths[name] if name in paths else Path(shutil.which(name) or "")
    else:
        path = Path(shutil.which(name) or "")
    if not path.is_file():
        raise RuntimeError(f"Provide --{name}-binary or install the requested test executable")
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, help="Independent npm test prefix (Linux x64 optional native packages)")
    parser.add_argument("--claude-binary")
    parser.add_argument("--opencode-binary")
    parser.add_argument("--codex-binary")
    parser.add_argument("--codex-tool-call", action="store_true", help="Also create an ephemeral Codex thread and call hub_context; requires working host sandbox helpers")
    parser.add_argument("--hosts", nargs="+", choices=("claude", "opencode", "codex"), default=["claude", "opencode", "codex"])
    parser.add_argument("--output", type=Path, help="Write a new token-free JSON verification report")
    args = parser.parse_args()
    executables = {name: binary(getattr(args, name + "_binary"), args.runtime_dir, name) for name in args.hosts}
    results = []
    with tempfile.TemporaryDirectory(prefix="teamhub-harness-check-") as temporary:
        directory = Path(temporary).resolve()
        env = environment(directory)
        port = free_port()
        url = f"http://127.0.0.1:{port}"
        connection = directory / "connection.json"
        connection.write_text(json.dumps({"url": url, "token": "demo-lin"}), encoding="utf-8")
        connection.chmod(0o600)
        with (directory / "hub.log").open("w", encoding="utf-8") as log:
            hub = subprocess.Popen([sys.executable, "-m", "teamhub", "serve", "--demo", "--data-dir",
                str(directory / "hub-data"), "--port", str(port)], cwd=directory, env=env, stdout=log, stderr=log)
            try:
                with httpx.Client(trust_env=False, timeout=2) as client:
                    for _ in range(100):
                        if hub.poll() is not None:
                            raise RuntimeError("The isolated Hub exited before becoming healthy; install this project's mcp extra first")
                        try:
                            if client.get(url + "/api/v1/health").is_success:
                                break
                        except httpx.TransportError:
                            pass
                        time.sleep(.1)
                    else:
                        raise RuntimeError("The isolated Hub did not become healthy")
                checks = {"claude": check_claude, "opencode": check_opencode, "codex": check_codex}
                for name in args.hosts:
                    print(f"Checking {name} with a generated MCP configuration...", flush=True)
                    extra = {"call_tool": args.codex_tool_call} if name == "codex" else {}
                    result = checks[name](executables[name], directory, env, connection, **extra)
                    results.append(result)
                    print(json.dumps(result, ensure_ascii=False), flush=True)
            finally:
                stop(hub)
    report = {"platform": platform.system(), "model_calls": 0, "existing_profiles_modified": False,
              "hub_data": "isolated demo workspace", "results": results}
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        print(redact(str(error)), file=sys.stderr)
        raise SystemExit(1)
