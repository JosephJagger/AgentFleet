#!/usr/bin/env python3
"""Run the real installer against a loopback release server in an isolated home.
Root invocation drops to nobody; --isolated-root is only allowed in a disposable
container and tests the installer's hard-coded root path as well.
"""
import argparse
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument("--installer", type=Path, default=Path(__file__).with_name("install.sh"))
parser.add_argument("--isolated-root", action="store_true")
args = parser.parse_args()
if args.isolated_root:
    assert os.getuid() == 0 and Path("/.dockerenv").exists(), "root test requires a disposable Docker container"
    assert not Path("/root/.local/share/agentfleet").exists(), "refusing to touch an existing root installation"

with tempfile.TemporaryDirectory(prefix="agentfleet-prepare-test-") as temporary:
    base = Path(temporary)
    base.chmod(0o755)
    installer = base / "install.sh"
    shutil.copyfile(args.installer, installer)
    installer.chmod(0o755)
    requests = []
    responses = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            body = responses.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.end_headers()
            self.wfile.write(body or b"unexpected download")
        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    uid = 65534 if os.getuid() == 0 and not args.isolated_root else os.getuid()

    def lower_privileges():
        if os.getuid() == 0 and uid != 0:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)

    def snapshot(paths):
        result = {}
        for path in paths:
            if path.is_symlink():
                result[str(path)] = ("link", os.readlink(path), path.lstat().st_mtime_ns)
            elif path.is_file():
                result[str(path)] = ("file", path.read_bytes(), path.stat().st_mtime_ns)
            else:
                result[str(path)] = None
        return result

    try:
        for fmt in ("portable", "sea"):
            for existing in (True, False):
                case = base / f"{fmt}-{existing}"
                case.mkdir()
                home = Path("/root") if args.isolated_root else case / "home"
                home.mkdir(exist_ok=True)
                data = home / ".local/share/agentfleet"
                user_bin = home / ".local/bin"
                data.mkdir(parents=True)
                user_bin.mkdir(parents=True, exist_ok=True)
                forbidden = case / "forbidden-calls"
                binary = (
                    '#!/bin/sh\nif [ "${1:-}" = --version ]; then echo 9.8.9; exit 0; fi\n'
                    f"printf '%s\\n' \"$*\" >> '{forbidden}'\nexit 77\n"
                ).encode()
                runtime = data / "codex/codex"
                profile = data / "runtime-profile.json"
                state = data / "state.sqlite"
                service = home / ".config/systemd/user/agentfleet.service"
                current, previous = user_bin / "agentfleet", user_bin / "agentfleet.previous"
                if existing:
                    for version in ("9.8.7", "9.8.8"):
                        old = data / "bin" / version / "agentfleet"
                        old.parent.mkdir(parents=True)
                        old.write_bytes(binary)
                        old.chmod(0o755)
                    current.symlink_to(data / "bin/9.8.8/agentfleet")
                    previous.symlink_to(data / "bin/9.8.7/agentfleet")
                    runtime.parent.mkdir()
                    runtime.write_bytes(binary)
                    runtime.chmod(0o755)
                    profile.write_text(json.dumps({"schemaVersion": 1, "codexExecutable": str(runtime), "source": "managed"}))
                    with sqlite3.connect(state) as db:
                        db.execute("create table active_task (id text)")
                        db.execute("insert into active_task values ('must-continue')")
                    service.parent.mkdir(parents=True, exist_ok=True)
                    service.write_text("existing service must not be changed\n")
                paths = [current, previous, runtime, profile, state, service, data / "update-state.json",
                         data / "bin/9.8.7/agentfleet", data / "bin/9.8.8/agentfleet"]
                before = snapshot(paths)
                if fmt == "portable":
                    archive = io.BytesIO()
                    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                        info = tarfile.TarInfo("agentfleet/agentfleet")
                        info.size, info.mode = len(binary), 0o755
                        tar.addfile(info, io.BytesIO(binary))
                    artifact = archive.getvalue()
                    filename = "agentfleet-linux-x64-9.8.9.tar.gz"
                else:
                    artifact, filename = binary, "agentfleet-linux-x64-9.8.9"
                manifest = {"schemaVersion": 1, "version": "9.8.9", "artifacts": {"linux-x64": {
                    "file": filename, "format": fmt, "size": len(artifact), "sha256": hashlib.sha256(artifact).hexdigest()}}}
                responses.clear()
                responses.update({"/downloads/manifest.json": json.dumps(manifest, separators=(",", ":")).encode(),
                                  "/downloads/" + filename: artifact})
                if uid != os.getuid():
                    for path in [case, *case.rglob("*")]:
                        os.chown(path, uid, uid, follow_symlinks=False)
                # A live task is kept running throughout preparation.
                task = subprocess.Popen(["sleep", "60"], preexec_fn=lower_privileges)
                try:
                    for attempt in range(2):  # first extraction and reuse of an existing candidate
                        requests.clear()
                        result = subprocess.run(["sh", str(installer), "--prepare-only", "--url", origin],
                                                env={**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share"),
                                                     "AGENTFLEET_EXPECTED_VERSION": "9.8.9"},
                                                preexec_fn=lower_privileges, capture_output=True, text=True, timeout=30)
                        assert result.returncode == 0, result.stdout + result.stderr
                        assert "Prepared AgentFleet 9.8.9" in result.stdout, result.stdout
                        assert snapshot(paths) == before, "preparation mutated the active installation"
                        assert task.poll() is None, "preparation interrupted a running process"
                        assert not forbidden.exists(), "preparation invoked runtime, service or onboarding"
                        assert (data / "bin/9.8.9/agentfleet").exists(), "candidate not prepared"
                        assert not (data / ".installer-lock").exists(), "installer lock leaked"
                        assert all(p in responses for p in requests), f"unexpected runtime download: {requests}"
                    # A failed integrity check must preserve the same invariants.
                    manifest["artifacts"]["linux-x64"]["sha256"] = "0" * 64
                    responses["/downloads/manifest.json"] = json.dumps(manifest, separators=(",", ":")).encode()
                    result = subprocess.run(["sh", str(installer), "--prepare-only", "--url", origin],
                                            env={**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share")},
                                            preexec_fn=lower_privileges, capture_output=True, text=True, timeout=30)
                    assert result.returncode != 0, "corrupt release accepted"
                    assert snapshot(paths) == before and not forbidden.exists()
                    assert task.poll() is None
                    print(f"PASS {fmt}, existing={existing}: prepare/repeat/corrupt preserve installation and live task")
                finally:
                    task.terminate()
                    task.wait()
                if args.isolated_root:
                    shutil.rmtree(data)
                    for link in (current, previous):
                        link.unlink(missing_ok=True)
                    service.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
