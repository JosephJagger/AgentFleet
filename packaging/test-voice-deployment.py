import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy-control-plane.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

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

    def invoke(self, fail=False):
        commands = []
        def runner(*args):
            commands.append(args)
            if args[:3] == ('docker', 'image', 'inspect'):
                return json.dumps([{'Id':'sha256:fixture', 'Config':{'Env':['AGENTFLEET_BUILD_SHA=fixture-build']}}])
            if args[:2] == ('docker', 'compose') and fail:
                raise RuntimeError('synthetic switch failure')
            return ''
        with patch.object(deploy.sys, 'argv', ['deploy', '--database', str(self.path), '--image', 'fixture']), patch.object(deploy, 'run', runner), patch.object(deploy, 'health', return_value={'status':'ok','build':'fixture-build','voiceDeploymentGuard':1,'schemaVersion':52}):
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
        self.assertEqual(commands[1], ('docker','tag','sha256:fixture','agentfleet:local'))
        self.assertEqual(commands[2][-4:], ('-d','--no-deps','--no-build','control-plane'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 0)
        self.assertEqual(len(list(self.path.parent.glob('*.predeploy-*.sqlite'))), 1)

    def test_failed_switch_retains_fence_for_explicit_recovery(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic switch failure'):
            self.invoke(fail=True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM voice_deployment_guard').fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
