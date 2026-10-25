"""저장소의 MCP 서버를 Codex에 등록한다. Python 3.11+, 외부 의존성 없음."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
NAME = "samba-browser"


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{toml_value(k)} = {toml_value(v)}" for k, v in value.items()) + " }"
    raise ValueError("지원하지 않는 기존 MCP 설정 형식입니다. 파일은 변경하지 않았습니다.")


def updated_config(text, node, app_config):
    original = tomllib.loads(text)
    current = dict(original.get("mcp_servers", {}).get(NAME, {}))
    if "url" in current:
        raise ValueError("기존 samba-browser는 HTTP 등록입니다. 자동으로 바꾸지 않습니다.")
    current.update(command=str(node), args=[str(HERE / "server.mjs")])
    # stdio 서버의 작업 경로와 앱 설정 경로를 설치한 PC 기준으로 지정한다.
    current["cwd"] = str(HERE)
    current["env"] = {**current.get("env", {}), "SAMBA_BROWSER_CONFIG": str(app_config)}
    block = f"[mcp_servers.{NAME}]\n" + "".join(
        f"{toml_value(k)} = {toml_value(v)}\n" for k, v in current.items()
    )
    # 다른 서버·프로젝트 설정은 원문 그대로 보존한다. 결과를 다시 파싱해 의미도 대조한다.
    parts = re.split(r"(?m)^(?=\[)", text)
    kept = []
    own_header = re.compile(r'^\[mcp_servers\.(?:samba-browser|"samba-browser"|\'samba-browser\')(?:\.|\])')
    for part in parts:
        if not own_header.match(part):
            kept.append(part)
    result = "".join(kept).rstrip() + "\n\n" + block
    parsed = tomllib.loads(result)
    expected = {**original, "mcp_servers": {**original.get("mcp_servers", {}), NAME: current}}
    if parsed != expected:
        raise ValueError("기존 설정 보존 검사가 실패했습니다. 파일은 변경하지 않았습니다.")
    return result


def write_config(path, content, before):
    after = content.encode("utf-8")
    if before == after:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if before is not None:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = path.with_name(path.name + f".bak-samba-browser-{stamp}")
        backup.write_bytes(before)
    temp = path.with_name(path.name + f".samba-{secrets.token_hex(6)}.tmp")
    try:
        temp.write_bytes(after)
        if (path.read_bytes() if path.exists() else None) != before:
            raise ValueError("설정이 다른 작업에서 변경되었습니다. 덮어쓰지 않았습니다.")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    return True


def prepare_bridge(path):
    if path.exists():
        config = json.loads(path.read_text(encoding="utf-8-sig"))
        return bool(config.get("bridgeEnabled") and config.get("bridgeToken"))
    # 첫 설치에만 로컬 브릿지를 켠다. 기존 앱의 설정·토큰은 읽기만 한다.
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump({"bridgeEnabled": True, "bridgePort": 47811,
                   "bridgeToken": secrets.token_hex(32)}, stream, indent=2)
    return True


def check_connection(node, app_config):
    config = json.loads(app_config.read_text(encoding="utf-8-sig"))
    if not config.get("bridgeEnabled") or not config.get("bridgeToken"):
        raise ValueError("앱 설정 → 동작 → 하네스 브릿지를 켜세요.")
    port = config.get("bridgePort", 47811)
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("앱 브릿지 포트가 올바르지 않습니다.")
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health",
                                     headers={"X-Samba-Token": config["bridgeToken"]})
    # 로컬 연결에는 시스템 HTTP 프록시를 쓰지 않는다.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=5) as response:
            health = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
        # /health는 다른 자동화가 도는 동안 409다. 독립 레인에서 탭 목록만 읽어 연결을 확인한다.
        lane = "cc-setup-" + secrets.token_hex(4)
        probe = urllib.request.Request(f"http://127.0.0.1:{port}/tool/list_tabs",
            data=b'{"args":{}}', headers={"X-Samba-Token": config["bridgeToken"],
                "X-Samba-Lane": lane, "Content-Type": "application/json"})
        with opener.open(probe, timeout=5) as response:
            health = json.load(response)
        if health.get("lane") != lane:
            raise ValueError("브라우저가 사용 중입니다. 작업이 끝난 뒤 다시 검사하세요.")
        health["tools"] = ["list_tabs"]
    if not health.get("ok") or not health.get("tools"):
        raise ValueError("브릿지 도구 목록이 비어 있습니다.")
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "samba-setup-check", "version": "1.0.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "ping"},
    ]
    completed = subprocess.run([node, str(HERE / "server.mjs")],
        input="".join(json.dumps(m) + "\n" for m in messages),
        capture_output=True, text=True, encoding="utf-8", timeout=15, check=True,
        env={**os.environ, "SAMBA_BROWSER_CONFIG": str(app_config)})
    replies = {r["id"]: r for line in completed.stdout.splitlines() if (r := json.loads(line)).get("id")}
    if any("result" not in replies.get(i, {}) for i in (1, 2, 3)):
        raise ValueError("MCP 초기화·도구 목록·ping 검사가 실패했습니다.")
    names = {t["name"] for t in replies[2]["result"]["tools"]}
    if not {"list_tabs", "get_page", "samba_lane"} <= names:
        raise ValueError("필수 MCP 도구가 없습니다.")
    return len(names)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))
    default_app = Path(os.environ.get("APPDATA", Path.home() / ".config")) / "SAMBA Browser" / "config.json"
    parser.add_argument("--app-config", type=Path, default=Path(os.environ.get("SAMBA_BROWSER_CONFIG", default_app)))
    parser.add_argument("--check", action="store_true", help="설정을 바꾸지 않고 실행 중 브릿지와 MCP를 검사")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 20 이상을 설치하세요.")
    if args.check:
        count = check_connection(node, args.app_config.resolve())
        print(f"연결 정상: 브릿지 인증, MCP 초기화, 도구 {count}개, ping 확인")
        return
    config_path = args.codex_home.expanduser().resolve() / "config.toml"
    before = config_path.read_bytes() if config_path.exists() else None
    text = before.decode("utf-8-sig") if before is not None else ""
    updated = updated_config(text, node, args.app_config.resolve())
    ready = prepare_bridge(args.app_config.resolve())
    changed = write_config(config_path, updated, before)
    print("Codex MCP 등록 완료" if changed else "Codex MCP 등록이 이미 최신입니다")
    print("기존 MCP·REA·프로젝트 설정 보존 검사를 통과했습니다.")
    if not ready:
        print("기존 브릿지가 꺼져 있습니다. 앱 설정 → 동작 → 하네스 브릿지를 켜세요.")
    print("삼바브라우저를 실행한 뒤 Codex MCP를 다시 연결하거나 새 채팅을 여세요.")
    print("실행 중인 앱·Codex·MCP 프로세스는 종료하지 않았습니다.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"설치·검사 실패: {type(error).__name__}. 앱 실행·브릿지 설정·설정 파일 형식을 확인하세요.", file=sys.stderr)
        sys.exit(1)
