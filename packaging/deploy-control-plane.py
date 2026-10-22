#!/usr/bin/env python3
"""Publish a prepared panel image only after both kinds of voice call and every SSH relay stream have ended.
Requires local Docker/Compose, Python 3 and read/write access to the shared SQLite DB.
No task dispatch, host restart, forced call closure or implicit rollback is performed.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from deployment_provenance import validate_candidate

SCHEMA = json.loads((ROOT / 'apps/control-plane/src/voice-deployment-schema.json').read_text())


# The panel refreshes a live relay stream's row every 30 seconds. A row nobody has touched for this long was left behind
# by a process that died, and waiting for it would block every future deployment.
STALE_RELAY_SECONDS = 300


def counts(db):
    active = {table: db.execute(f"SELECT count(*) FROM {table} WHERE state<>'closed'").fetchone()[0]
              for table in ('panel_voice_calls', 'voice_sessions')}
    # SSH relay streams exist from schema 70 on; an older database simply has none. Restarting the panel cuts them off,
    # so a deployment waits for them exactly as it waits for voice calls.
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ssh_relay_streams'").fetchone():
        active['ssh_relay_streams'] = db.execute(
            "SELECT count(*) FROM ssh_relay_streams WHERE closed_at IS NULL AND last_active_at>strftime('%Y-%m-%dT%H:%M:%fZ','now',?)",
            (f'-{STALE_RELAY_SECONDS} seconds',)).fetchone()[0]
    return active


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


DEFAULT_KEEP_BACKUPS = 5


def prune_backups(db_path, keep):
    """Delete the oldest pre-deploy backups of this database, keeping the newest `keep`.

    Only files named exactly `<db>.predeploy-<32 hex>.sqlite` (and their -wal/-shm sidecars) are touched.
    Every publication writes a full copy of the database, so without this the data volume fills up.
    """
    db_path = Path(db_path)
    pattern = re.compile(re.escape(db_path.name) + r'\.predeploy-[0-9a-f]{32}\.sqlite')
    backups = sorted((p for p in db_path.parent.iterdir() if pattern.fullmatch(p.name)), key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    removed = []
    for old in backups[max(0, keep):]:
        for suffix in ('', '-wal', '-shm'):
            with contextlib.suppress(FileNotFoundError):
                Path(str(old) + suffix).unlink()
        removed.append(old.name)
    return removed


def backup_database(db, backup_path):
    """Back the database up; a failed (for example disk-full) backup never leaves a partial file behind."""
    fd = os.open(backup_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        with contextlib.closing(sqlite3.connect(backup_path)) as backup:
            db.backup(backup)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(backup_path)
        raise


def ensure_backup_space(db_path):
    need = Path(db_path).stat().st_size * 12 // 10 + 256 * 2**20
    free = shutil.disk_usage(Path(db_path).parent).free
    if free < need:
        raise RuntimeError(f'Not enough free disk space for the pre-deploy backup ({free // 2**20} MB free, {need // 2**20} MB needed). '
                           'Nothing was changed; free some space and retry.')


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
    parser.add_argument('--public-origin', help='Public panel origin; defaults to running service PUBLIC_ORIGIN')
    parser.add_argument('--with-validator', action='store_true', help='Also update the idle Codex validation worker; defer while validation is running')
    parser.add_argument('--keep-backups', type=int, default=DEFAULT_KEEP_BACKUPS, help='Pre-deploy database backups to keep (default 5); older ones are deleted before a new one is written')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--release', action='store_true', help='Explicitly release an abandoned fence after checking service health')
    args = parser.parse_args()
    if args.keep_backups < 1:
        parser.error('--keep-backups must be at least 1')
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
            runtime = json.loads(run('docker', 'inspect', 'agentfleet-control-plane'))[0]
            validate_candidate(ROOT, image, runtime)
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
                if args.with_validator:
                    state = json.loads(run('docker', 'exec', 'agentfleet-runtime-validator', 'node', '-e',
                                           "console.log(JSON.stringify(require('/app/runtime-releases/state.json')))"))
                    if state.get('phase') in ('checking', 'downloading', 'validating'):
                        print('Deferred: Codex validation is running; no service restarted.')
                        return 75
                # Verify the actual public update channel after switching, not only image files.
                runtime = json.loads(run('docker', 'inspect', 'agentfleet-control-plane'))[0]
                public_origin = args.public_origin or next((v.split('=', 1)[1] for v in runtime['Config'].get('Env', []) if v.startswith('PUBLIC_ORIGIN=')), None)
                if not public_origin:
                    raise RuntimeError('Public origin is required for release verification')
                expected_version = run('docker', 'run', '--rm', '--entrypoint', 'node', image_id,
                                       '-e', "console.log(JSON.parse(require('node:fs').readFileSync('/app/web/downloads/manifest.json','utf8')).version)")
                backup_path = str(path) + '.predeploy-' + token + '.sqlite'
                # Make room first: keep the newest (keep - 1) so that, with the new one, `keep` remain.
                pruned = prune_backups(path, args.keep_backups - 1)
                if pruned:
                    print(json.dumps({'phase': 'pruned_backups', 'removed': len(pruned)}), flush=True)
                ensure_backup_space(path)
                backup_database(db, backup_path)
                # Recheck after draining and backup: another release or main commit may have arrived.
                runtime = json.loads(run('docker', 'inspect', 'agentfleet-control-plane'))[0]
                validate_candidate(ROOT, image, runtime)
                # Fence remains in the shared DB throughout recreation and startup.
                switching = True
                run('docker', 'tag', image_id, 'agentfleet:local')
                services = ['control-plane', 'runtime-validator'] if args.with_validator else ['control-plane']
                run('docker', 'compose', 'up', '-d', '--no-deps', '--no-build', *services)
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    try:
                        status = health(args.ready_url)
                        if status.get('status') == 'ok' and status.get('build') == build and status.get('voiceDeploymentGuard') == 1:
                            release(db, token)
                            acquired = False
                            try:
                                run('node', str(ROOT / 'packaging/verify-published-installers.mjs'), public_origin, expected_version)
                            except Exception as error:
                                raise RuntimeError(f'Panel is healthy, but public release verification failed: {error}. No rollback performed; verify public routes before reporting publication.') from error
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
