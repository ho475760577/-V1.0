"""StoryRealm static server with a small local workspace persistence API."""

import argparse
import json
import os
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WORKSPACE_FILE = DATA_DIR / "storyrealm-workspace.json"
MAX_BODY = 64 * 1024 * 1024


def read_workspace():
    if not WORKSPACE_FILE.exists():
        return None
    try:
        with WORKSPACE_FILE.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        if value.get("schema") != "storyrealm.workspace" or value.get("version") != 1:
            return None
        return value
    except (OSError, ValueError, AttributeError):
        return None


def write_workspace(value):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="storyrealm-", suffix=".tmp", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, WORKSPACE_FILE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/api/workspace":
            workspace = read_workspace()
            self.send_json({"workspace": workspace, "updatedAt": workspace.get("updatedAt", 0) if workspace else 0})
            return
        if urlparse(self.path).path.startswith("/data/"):
            self.send_error(404)
            return
        super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/workspace":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            workspace = payload.get("workspace")
            if not isinstance(workspace, dict) or workspace.get("schema") != "storyrealm.workspace" or workspace.get("version") != 1:
                raise ValueError("invalid workspace")
            workspace["updatedAt"] = max(int(payload.get("clientUpdatedAt", 0)), 0)
            write_workspace(workspace)
            self.send_json({"ok": True, "updatedAt": workspace["updatedAt"]})
        except (ValueError, TypeError, json.JSONDecodeError, OSError) as error:
            self.send_error(400, str(error))

    def send_json(self, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/workspace"):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    os.chdir(ROOT)
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"StoryRealm server: http://{args.bind}:{args.port}")
    print(f"Workspace file: {WORKSPACE_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
