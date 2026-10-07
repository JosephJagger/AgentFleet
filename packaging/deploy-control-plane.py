#!/usr/bin/env python3
"""Publish a prepared panel image only after both kinds of voice call have ended.
Requires local Docker/Compose, Python 3 and read/write access to the shared SQLite DB.
No task dispatch, host restart, forced call closure or implicit rollback is performed.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'apps/control-plane/src/voice-deployment-schema.json').read_text())


def counts(db):
    return {table: db.execute(f"SELECT count(*) FROM {table} WHERE state<>'closed'").fetchone()[0]
            for table in ('panel_voice_calls', 'voice_sessions')}


def acquire(db, target, token):
    # This additive bootstrap does not change user_version: it fences the old binary
    # on the very first deployment too. Both triggers and the lease are atomic.
    db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nCOMMIT;')
    with db:
        db.execute("INSERT INTO voice_deployment_guard VALUES(1,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (token, target))


def release(db, token):
    with db:
        db.execute('DELETE FROM voice_deployment_guard WHERE singleton=1 AND token=?', (token,))


def wait_idle(db, token, seconds, sleep=time.sleep, clock=time.monotonic):
    deadline = clock() + seconds
    while True:
        row = db.execute('SELECT token FROM voice_deployment_guard WHERE singleton=1').fetchone()
        if not row or row[0] != token:
            raise RuntimeError('Deployment fence ownership changed; refusing to publish')
        active = counts(db)
        if not any(active.values()):
            return True
        print(json.dumps({'phase': 'waiting_for_calls', 'active': active}), flush=True)
        if clock() >= deadline:
            return False
        sleep(min(2, max(0, deadline - clock())))


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def health(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--image', help='Already built immutable image tag or digest')
    parser.add_argument('--wait-seconds', type=int, default=0, help='On timeout keep old service, reopen admission, exit 75')
    parser.add_argument('--ready-url', default='http://127.0.0.1:3215/ready')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--release', action='store_true', help='Explicitly release an abandoned fence after checking service health')
    args = parser.parse_args()
    if not 0 <= args.wait_seconds <= 3600:
        parser.error('--wait-seconds must be between 0 and 3600')
    if sum([args.check, args.release, bool(args.image)]) != 1:
        parser.error('Choose exactly one of --image, --check, --release')
    path = Path(args.database).resolve(strict=True)
    # OS lock dies with the publisher; durable fence deliberately does not expire.
    with open(str(path) + '.publish.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=10)) as db:
            if args.check:
                print(json.dumps({'active': counts(db), 'fenced': bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='voice_deployment_guard'").fetchone() and db.execute('SELECT 1 FROM voice_deployment_guard').fetchone())}))
                return 0
            if args.release:
                if health(args.ready_url).get('status') != 'ok':
                    raise RuntimeError('Service is not healthy; keep deployment fence')
                with db:
                    db.execute('DELETE FROM voice_deployment_guard')
                print('Abandoned deployment fence released; no service restarted.')
                return 0
            image = json.loads(run('docker', 'image', 'inspect', args.image))[0]
            image_id = image['Id']  # pin before waiting; mutable tags cannot switch underneath us
            build = next((v.split('=', 1)[1] for v in image['Config'].get('Env', []) if v.startswith('AGENTFLEET_BUILD_SHA=')), None)
            if not build or build in ('unknown', 'local'):
                raise RuntimeError('Target image needs a concrete AGENTFLEET_BUILD_SHA')
            token = uuid.uuid4().hex
            acquired = switching = False
            try:
                acquire(db, image_id, token)
                acquired = True
                if not wait_idle(db, token, args.wait_seconds):
                    print('Deferred: active or uncertain calls remain. Old service unchanged; new calls reopened.')
                    return 75
                backup_path = str(path) + '.predeploy-' + token + '.sqlite'
                fd = os.open(backup_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                with contextlib.closing(sqlite3.connect(backup_path)) as backup:
                    db.backup(backup)
                # Fence remains in the shared DB throughout recreation and startup.
                switching = True
                run('docker', 'tag', image_id, 'agentfleet:local')
                run('docker', 'compose', 'up', '-d', '--no-deps', '--no-build', 'control-plane')
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    try:
                        status = health(args.ready_url)
                        if status.get('status') == 'ok' and status.get('build') == build and status.get('voiceDeploymentGuard') == 1:
                            release(db, token)
                            acquired = False
                            print(json.dumps({'phase': 'published', 'build': build, 'schema': status.get('schemaVersion'), 'backup': backup_path}))
                            return 0
                    except (OSError, ValueError):
                        pass
                    time.sleep(2)
                raise RuntimeError('New service readiness not verified; fence retained. Inspect deployment, then explicitly --release. No automatic rollback.')
            finally:
                if acquired and not switching:
                    release(db, token)
                elif acquired:
                    print('Deployment fence retained to prevent new calls during an uncertain switch.', file=sys.stderr)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
