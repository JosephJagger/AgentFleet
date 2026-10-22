import importlib.util
from pathlib import Path
import sqlite3
import os
import tempfile
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy-control-plane.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.db = self.dir / 'control-plane.sqlite'
        self.db.write_bytes(b'live')
        self.addCleanup(self.tmp.cleanup)

    def backup(self, token, age):
        path = self.dir / f'control-plane.sqlite.predeploy-{token * 32}.sqlite'
        path.write_bytes(b'x')
        os.utime(path, (1_000_000 + age, 1_000_000 + age))
        return path

    def remaining(self):
        return sorted(p.name.split('predeploy-')[1][0] for p in self.dir.glob('control-plane.sqlite.predeploy-' + '?' * 32 + '.sqlite'))

    def test_keeps_the_newest_and_touches_nothing_else(self):
        made = [self.backup(token, age) for age, token in enumerate('1234567')]   # 7 is the newest
        sidecar = self.dir / (made[0].name + '-wal')
        sidecar.write_bytes(b'w')
        others = [self.dir / 'pre-blog-assignment-repair-20260922T0055Z.sqlite',
                  self.dir / 'control-plane.sqlite.predeploy-notahexname.sqlite',
                  self.dir / ('other.sqlite.predeploy-' + 'a' * 32 + '.sqlite')]
        for path in others:
            path.write_bytes(b'keep me')
        removed = deploy.prune_backups(self.db, 3)
        self.assertEqual(len(removed), 4)
        self.assertEqual(self.remaining(), ['5', '6', '7'])
        self.assertFalse(sidecar.exists())
        self.assertTrue(self.db.exists() and all(path.exists() for path in others))
        self.assertEqual(deploy.prune_backups(self.db, 3), [])                     # idempotent
        self.assertEqual(len(deploy.prune_backups(self.db, 0)), 3)                 # keep=0 removes only matching backups
        self.assertTrue(self.db.exists() and all(path.exists() for path in others))

    def test_failed_backup_leaves_no_partial_file(self):
        class FullDisk:
            def backup(self, _target):
                raise sqlite3.OperationalError('database or disk is full')
        target = self.dir / ('control-plane.sqlite.predeploy-' + 'd' * 32 + '.sqlite')
        with self.assertRaisesRegex(sqlite3.OperationalError, 'disk is full'):
            deploy.backup_database(FullDisk(), str(target))
        self.assertFalse(target.exists())

    def test_refuses_to_start_a_backup_without_enough_space(self):
        with patch.object(deploy.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 10 * 2**20})()):
            with self.assertRaisesRegex(RuntimeError, 'Not enough free disk space'):
                deploy.ensure_backup_space(self.db)
        with patch.object(deploy.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 10 * 2**30})()):
            deploy.ensure_backup_space(self.db)


class DeploymentFenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'db.sqlite'
        self.db = sqlite3.connect(self.path)
        self.db.executescript("CREATE TABLE panel_voice_calls(id TEXT,state TEXT); CREATE TABLE voice_sessions(id TEXT,state TEXT); PRAGMA user_version=51;")
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.db.close)

    def test_old_binary_inserts_are_fenced_but_existing_calls_can_finish(self):
        self.db.execute("INSERT INTO panel_voice_calls VALUES('call','active')")
        self.db.execute("INSERT INTO voice_sessions VALUES('native','closing')")
        self.db.commit()
        deploy.acquire(self.db, 'image', 'owner')
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 51)
        with sqlite3.connect(self.path) as old:
            for table in ['panel_voice_calls', 'voice_sessions']:
                with self.assertRaisesRegex(sqlite3.IntegrityError, 'VOICE_DEPLOYMENT_WAIT'):
                    old.execute(f"INSERT INTO {table} VALUES('new','starting')")
        self.assertFalse(deploy.wait_idle(self.db, 'owner', 0))
        self.db.execute("UPDATE panel_voice_calls SET state='closed'")
        self.db.commit()
        self.assertFalse(deploy.wait_idle(self.db, 'owner', 0))
        self.db.execute("UPDATE voice_sessions SET state='closed'")
        self.db.commit()
        self.assertTrue(deploy.wait_idle(self.db, 'owner', 0))
        deploy.release(self.db, 'other')
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 1)
        deploy.release(self.db, 'owner')
        self.db.execute("INSERT INTO voice_sessions VALUES('allowed','starting')")

    def test_concurrent_publishers_and_restarts_cannot_bypass_fence(self):
        deploy.acquire(self.db, 'image', 'owner')
        with sqlite3.connect(self.path) as second:
            with self.assertRaises(sqlite3.IntegrityError):
                deploy.acquire(second, 'other', 'intruder')
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                deploy.wait_idle(second, 'intruder', 0)
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'VOICE_DEPLOYMENT_WAIT'):
                second.execute("INSERT INTO panel_voice_calls VALUES('new','starting')")
        self.assertEqual(self.db.execute('SELECT token FROM voice_deployment_guard').fetchone()[0], 'owner')

    def test_wait_allows_natural_close_without_changing_call_state(self):
        self.db.execute("INSERT INTO panel_voice_calls VALUES('existing','active')")
        self.db.commit()
        deploy.acquire(self.db, 'image', 'owner')
        def user_hangs_up(_):
            self.assertEqual(self.db.execute('SELECT state FROM panel_voice_calls').fetchone()[0], 'active')
            self.db.execute("UPDATE panel_voice_calls SET state='closed'")
            self.db.commit()
        self.assertTrue(deploy.wait_idle(self.db, 'owner', 10, sleep=user_hangs_up))

    def invoke(self, fail=False, public_fail=False, validator_phase=None):
        commands = []
        def runner(*args):
            commands.append(args)
            if args[:3] == ('docker', 'image', 'inspect'):
                return json.dumps([{'Id':'sha256:fixture', 'Config':{'Env':['AGENTFLEET_BUILD_SHA=fixture-build']}}])
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([{'Config':{'Env':['PUBLIC_ORIGIN=https://example.test']}}])
            if args[:2] == ('docker', 'exec'):
                return json.dumps({'phase':validator_phase})
            if args[:2] == ('docker', 'run'):
                return '1.2.3'
            if args[0] == 'node' and public_fail:
                raise RuntimeError('public release mismatch')
            if args[:2] == ('docker', 'compose') and fail:
                raise RuntimeError('synthetic switch failure')
            return ''
        with patch.object(deploy.sys, 'argv', ['deploy', '--database', str(self.path), '--image', 'fixture'] + (['--with-validator'] if validator_phase else [])), patch.object(deploy, 'run', runner), patch.object(deploy, 'health', return_value={'status':'ok','build':'fixture-build','voiceDeploymentGuard':1,'schemaVersion':52}):
            result = deploy.main()
        return result, commands

    def test_timeout_does_not_tag_or_restart_and_reopens_admission(self):
        self.db.execute("INSERT INTO panel_voice_calls VALUES('existing','active')")
        self.db.commit()
        result, commands = self.invoke()
        self.assertEqual(result, 75)
        self.assertEqual(len(commands), 1)  # inspect only
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT state FROM panel_voice_calls').fetchone()[0], 'active')

    def test_success_switches_only_after_empty_calls_and_health_releases_fence(self):
        result, commands = self.invoke()
        self.assertEqual(result, 0)
        self.assertEqual(commands[3], ('docker','tag','sha256:fixture','agentfleet:local'))
        self.assertEqual(commands[4][-4:], ('-d','--no-deps','--no-build','control-plane'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 0)
        self.assertEqual(len(list(self.path.parent.glob('*.predeploy-*.sqlite'))), 1)

    def test_busy_validator_defers_without_restarting_any_service(self):
        result, commands = self.invoke(validator_phase='validating')
        self.assertEqual(result, 75)
        self.assertFalse(any(cmd[:2] == ('docker', 'compose') for cmd in commands))
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 0)

    def test_idle_validator_is_included_only_when_requested(self):
        result, commands = self.invoke(validator_phase='promoted')
        self.assertEqual(result, 0)
        self.assertTrue(any(cmd[-2:] == ('control-plane', 'runtime-validator') for cmd in commands))

    def test_public_failure_does_not_claim_publication_or_lock_healthy_calls(self):
        with self.assertRaisesRegex(RuntimeError, 'public release mismatch'):
            self.invoke(public_fail=True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 0)

    def test_failed_switch_retains_fence_for_explicit_recovery(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic switch failure'):
            self.invoke(fail=True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 1)

class RelayStreamWaitTests(unittest.TestCase):
    """A deployment restarts the panel, which cuts relayed SSH sessions; it waits for them like it waits for calls."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'db.sqlite'
        self.db = sqlite3.connect(self.path)
        self.db.executescript("CREATE TABLE panel_voice_calls(id TEXT,state TEXT); CREATE TABLE voice_sessions(id TEXT,state TEXT);")
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.db.close)

    def make_relay_table(self):
        self.db.executescript("CREATE TABLE ssh_relay_streams(stream_id TEXT PRIMARY KEY, state TEXT, last_active_at TEXT, closed_at TEXT);")

    def add(self, stream_id, state, age_seconds, closed=False):
        self.db.execute(
            "INSERT INTO ssh_relay_streams VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?),?)",
            (stream_id, state, f'-{age_seconds} seconds', '2026-01-01T00:00:00.000Z' if closed else None))
        self.db.commit()

    def test_a_database_without_the_relay_table_is_simply_idle(self):
        self.assertEqual(deploy.counts(self.db), {'panel_voice_calls': 0, 'voice_sessions': 0})
        self.assertFalse(any(deploy.counts(self.db).values()))

    def test_live_streams_are_waited_for_whatever_their_state(self):
        self.make_relay_table()
        self.add('open-one', 'open', 5)
        self.add('suspended', 'suspended', 40)
        self.add('opening', 'opening', 1)
        self.assertEqual(deploy.counts(self.db)['ssh_relay_streams'], 3)

    def test_closed_streams_and_ghosts_of_a_dead_process_are_not_waited_for(self):
        self.make_relay_table()
        self.add('done', 'closed', 2, closed=True)
        self.add('ghost', 'open', deploy.STALE_RELAY_SECONDS + 60)
        self.add('fresh', 'open', deploy.STALE_RELAY_SECONDS - 60)
        self.assertEqual(deploy.counts(self.db)['ssh_relay_streams'], 1, 'only the stream the panel is still refreshing counts')

    def test_the_wait_ends_when_the_last_stream_closes_and_never_forces_it(self):
        self.make_relay_table()
        self.add('long-session', 'open', 3)
        deploy.acquire(self.db, 'image', 'owner')
        self.assertFalse(deploy.wait_idle(self.db, 'owner', 0), 'a live stream defers the deployment')
        self.assertEqual(self.db.execute("SELECT state FROM ssh_relay_streams").fetchone()[0], 'open', 'nothing is closed on its behalf')
        def closes(_):
            self.db.execute("UPDATE ssh_relay_streams SET closed_at='2026-01-01T00:00:00.000Z', state='closed'")
            self.db.commit()
        self.assertTrue(deploy.wait_idle(self.db, 'owner', 10, sleep=closes))


if __name__ == '__main__':
    unittest.main()
