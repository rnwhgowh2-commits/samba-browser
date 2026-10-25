"""다른 MCP 설정 보존과 실제 stdio 연결 검증."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import tomllib
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPEC = importlib.util.spec_from_file_location("samba_mcp_setup", Path(__file__).with_name("setup.py"))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js가 필요합니다")
    def test_install_both_clients_and_repeat_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / "codex/config.toml", root / "claude.json", root / "app.json"]
            command = [sys.executable, str(setup.HERE / "setup.py"), "--codex-home", str(paths[0].parent),
                       "--claude-config", str(paths[1]), "--app-config", str(paths[2])]
            first = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(first.returncode, 0, first.stderr)
            originals = [p.read_bytes() for p in paths]
            second = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual([p.read_bytes() for p in paths], originals)
            self.assertEqual(list(root.rglob("*.bak-*")), [])

    @unittest.skipUnless(shutil.which("node"), "Node.js가 필요합니다")
    def test_invalid_claude_config_leaves_codex_and_app_unmodified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            claude = root / "claude.json"
            claude.write_bytes(b'{"bad":')
            result = subprocess.run([sys.executable, str(setup.HERE / "setup.py"),
                "--codex-home", str(root / "codex"), "--claude-config", str(claude),
                "--app-config", str(root / "app.json")], capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(claude.read_bytes(), b'{"bad":')
            self.assertFalse((root / "codex/config.toml").exists())
            self.assertFalse((root / "app.json").exists())

    def test_claude_preserves_other_servers_account_and_projects(self):
        original = {"oauthAccount": {"accountUuid": "test-account"},
                    "projects": {"C:/work": {"hasTrustDialogAccepted": True}},
                    "mcpServers": {"rea": {"command": "rea.exe", "args": ["mcp"]},
                                   "samba-browser": {"command": "old", "env": {"KEEP": "yes"}}}}
        result = setup.updated_claude_config(json.dumps(original), "node", Path("app.json"))
        updated = json.loads(result)
        self.assertEqual(updated["oauthAccount"], original["oauthAccount"])
        self.assertEqual(updated["projects"], original["projects"])
        self.assertEqual(updated["mcpServers"]["rea"], original["mcpServers"]["rea"])
        self.assertEqual(updated["mcpServers"]["samba-browser"]["env"]["KEEP"], "yes")
        self.assertEqual(setup.updated_claude_config(result, "node", Path("app.json")), result)

    def test_new_claude_registration(self):
        entry = json.loads(setup.updated_claude_config("", "node", Path("app.json")))["mcpServers"]["samba-browser"]
        self.assertEqual(entry["type"], "stdio")
        self.assertEqual(entry["args"], [str(setup.HERE / "server.mjs")])
        self.assertNotIn("bridgeToken", entry["env"])

    def test_claude_invalid_json_and_http_rejected(self):
        for source in ('{"bad":', '{"mcpServers":{"samba-browser":{"type":"http","url":"https://example.com"}}}'):
            with self.assertRaises(ValueError):
                setup.updated_claude_config(source, "node", Path("app.json"))

    def test_claude_config_directory_override(self):
        with patch.dict(setup.os.environ, {"CLAUDE_CONFIG_DIR": "C:/claude-personal"}):
            self.assertEqual(setup.claude_config_path(), Path("C:/claude-personal/.claude.json"))

    def test_check_requires_both_registrations(self):
        with tempfile.TemporaryDirectory() as directory:
            codex, claude = Path(directory) / "config.toml", Path(directory) / ".claude.json"
            app = Path(directory) / "app.json"
            codex.write_text(setup.updated_config("", "node", app), encoding="utf-8")
            claude.write_text(setup.updated_claude_config("", "node", app), encoding="utf-8")
            setup.check_registrations(codex, claude, "node", app)
            claude.write_text('{"mcpServers":{}}', encoding="utf-8")
            with self.assertRaises(KeyError):
                setup.check_registrations(codex, claude, "node", app)

    def test_existing_servers_and_tool_policy_preserved(self):
        source = '''model = "example"
[mcp_servers.rea]
command = 'C:\\REA\\rea.exe'
startup_timeout_sec = 30
tool_timeout_sec = 450
[mcp_servers."samba-browser"]
command = "old-node"
args = [
  "old-server.mjs"
]
disabled_tools = ["login"]
[mcp_servers."samba-browser".env]
KEEP = "yes"
[projects.'C:\\project']
trust_level = "trusted"
'''
        result = setup.updated_config(source, "C:/Program Files/nodejs/node.exe", Path("C:/App/config.json"))
        before, after = tomllib.loads(source), tomllib.loads(result)
        self.assertEqual(before["mcp_servers"]["rea"], after["mcp_servers"]["rea"])
        self.assertEqual(before["projects"], after["projects"])
        browser = after["mcp_servers"]["samba-browser"]
        self.assertEqual(browser["disabled_tools"], ["login"])
        self.assertEqual(browser["env"]["KEEP"], "yes")
        self.assertEqual(setup.updated_config(result, "C:/Program Files/nodejs/node.exe", Path("C:/App/config.json")), result)

    def test_new_registration_contains_no_token(self):
        result = setup.updated_config("", "node", Path("app.json"))
        browser = tomllib.loads(result)["mcp_servers"]["samba-browser"]
        self.assertTrue(browser["args"][0].endswith("server.mjs"))
        self.assertNotIn("bridgeToken", result)

    def test_invalid_toml_rejected(self):
        with self.assertRaises(tomllib.TOMLDecodeError):
            setup.updated_config("bad = [", "node", Path("app.json"))

    def test_http_registration_rejected(self):
        with self.assertRaises(ValueError):
            setup.updated_config('[mcp_servers.samba-browser]\nurl="https://example.com"', "node", Path("app.json"))

    def test_backup_and_noop(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_bytes(b"original\r\n")
            self.assertTrue(setup.write_config(path, "new\n", b"original\r\n"))
            self.assertEqual(next(path.parent.glob("*.bak-*")).read_bytes(), b"original\r\n")
            self.assertFalse(setup.write_config(path, "new\n", b"new\n"))
            self.assertEqual(len(list(path.parent.glob("*.bak-*"))), 1)

    def test_concurrent_edit_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_bytes(b"other session")
            with self.assertRaises(ValueError):
                setup.write_config(path, "mine", b"before")
            self.assertEqual(path.read_bytes(), b"other session")

    def test_existing_bridge_not_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.json"
            original = b'{"bridgeEnabled": false, "bridgeToken": "local-only", "theme": "dark"}'
            path.write_bytes(original)
            self.assertFalse(setup.prepare_bridge(path))
            self.assertEqual(path.read_bytes(), original)

    def test_first_install_creates_bridge_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.json"
            self.assertTrue(setup.prepare_bridge(path))
            original = path.read_bytes()
            self.assertEqual(len(json.loads(original)["bridgeToken"]), 64)
            self.assertTrue(setup.prepare_bridge(path))
            self.assertEqual(path.read_bytes(), original)

    @unittest.skipUnless(shutil.which("node"), "Node.js가 필요합니다")
    def test_actual_stdio_server_against_authenticated_bridge(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/health" or self.headers.get("X-Samba-Token") != "test-local-token":
                    self.send_error(401)
                    return
                body = json.dumps({"ok": True, "tools": ["get_page", "list_tabs"]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "app.json"
                path.write_text(json.dumps({"bridgeEnabled": True, "bridgeToken": "test-local-token",
                                           "bridgePort": server.server_port}), encoding="utf-8")
                self.assertEqual(setup.check_connection(shutil.which("node"), path), 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @unittest.skipUnless(shutil.which("node"), "Node.js가 필요합니다")
    def test_busy_health_uses_read_only_lane(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_error(409)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path != "/tool/list_tabs" or self.headers.get("X-Samba-Token") != "test-local-token":
                    self.send_error(401)
                    return
                body = json.dumps({"ok": True, "lane": self.headers.get("X-Samba-Lane"), "result": "[]"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "app.json"
                path.write_text(json.dumps({"bridgeEnabled": True, "bridgeToken": "test-local-token",
                                           "bridgePort": server.server_port}), encoding="utf-8")
                self.assertGreater(setup.check_connection(shutil.which("node"), path), 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
