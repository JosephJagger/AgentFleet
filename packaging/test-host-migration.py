import importlib.util
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import host_migration as m
import deployment_provenance as p


class MigrationTests(unittest.TestCase):
    def test_backup_captures_committed_wal_without_mutating_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'live.sqlite', Path(directory) / 'snapshot.sqlite'
            with sqlite3.connect(source) as db:
                db.execute('pragma journal_mode=wal')
                db.execute('create table events(id integer primary key, body text)')
                db.execute("insert into events(body) values('committed in WAL')")
                db.commit()
                self.assertTrue(Path(str(source) + '-wal').exists())
                proof = m.snapshot_database(source, target)
                with sqlite3.connect(target) as backup:
                    self.assertEqual(backup.execute('select body from events').fetchall(), [('committed in WAL',)])
                self.assertEqual(proof['tables']['events'], 1)
                self.assertEqual(proof['sha256'], m.sha256(target))
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                self.assertEqual(db.execute('select count(*) from events').fetchone()[0], 1)

    def test_inventory_rejects_wrong_host_and_shell_injection(self):
        plan = {'sourceHost': socket.gethostname(), 'targetHost': 'target', 'sshAlias': 'af-target',
                'targetRoot': '/root/project', 'directory': '/root/migration',
                'containers': [{'Name': '/agentfleet-control-plane'}], 'syncDirectories': []}
        m.validate_inventory(plan)
        for bad in [{'sourceHost': 'other'}, {'targetHost': socket.gethostname()}, {'sshAlias': 'host; reboot'}, {'directory': 'relative'}]:
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                m.validate_inventory({**plan, **bad})

    def test_compose_preserves_credentials_and_mounts_but_pins_new_panel(self):
        def service(name, ports=None):
            return {'Name': '/' + name, 'Image': 'sha256:old',
                    'Config': {'Env': ['SECRET=preserve', 'AGENTFLEET_BUILD_SHA=old'], 'Cmd': ['node', 'app'], 'User': '1000'},
                    'HostConfig': {'PortBindings': ports or {}, 'ReadonlyRootfs': True, 'CapDrop': ['ALL']},
                    'Mounts': [{'Type': 'volume', 'Name': 'data', 'Destination': '/app/data', 'RW': True}]}
        containers = [service('agentfleet-control-plane', {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3215'}]}),
                      service('agentfleet-runtime-validator'), service('agentfleets-identity-1'), service('agentfleet-www')]
        result = m.compose_spec({'containers': containers, 'networkSubnet': '172.30.0.0/16'}, 'sha256:new', 'full-sha')
        cp = result['services']['control-plane']
        self.assertEqual(cp['image'], 'sha256:new')
        self.assertEqual(cp['environment'], {'SECRET': 'preserve', 'AGENTFLEET_BUILD_SHA': 'full-sha'})
        self.assertEqual(cp['ports'], ['127.0.0.1:3215:3000/tcp'])
        self.assertEqual(result['services']['identity']['image'], 'sha256:old')
        self.assertTrue(result['services']['website']['init'])
        self.assertTrue(result['volumes']['data']['external'])
        containers[0]['HostConfig']['PortBindings']['3000/tcp'][0]['HostIp'] = '0.0.0.0'
        with self.assertRaisesRegex(RuntimeError, 'loopback'):
            m.compose_spec({'containers': containers, 'networkSubnet': '172.30.0.0/16'}, 'sha256:new', 'full-sha')

    def test_retired_host_cannot_publish_but_target_can(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'registry', return_value=Path(directory)):
            m.private_json(Path(directory) / 'host-owner.json', {'activeHost': 'new-host'})
            with patch.object(p.socket, 'gethostname', return_value='old-host'), self.assertRaisesRegex(RuntimeError, 'handed production'):
                p.require_active_host(Path(directory))
            with patch.object(p.socket, 'gethostname', return_value='new-host'):
                p.require_active_host(Path(directory))

    def test_abort_after_traffic_admission_is_refused_before_any_mutation(self):
        migration = object.__new__(m.Migration)
        for phase in ['admitting_target', 'traffic_on_target', 'published', 'unknown']:
            migration.state = {'phase': phase}
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'reverse migration'):
                migration.abort()

    def test_graceful_stop_never_sends_sigkill(self):
        migration = object.__new__(m.Migration)
        migration.names = ['panel']
        calls = []
        def execute(argv):
            calls.append(argv)
            return json.dumps([{'State': {'Running': False}}]) if argv[1] == 'inspect' else ''
        with patch.object(m, 'execute', side_effect=execute):
            migration.graceful_stop()
        self.assertIn(['docker', 'kill', '--signal=SIGTERM', 'panel'], calls)
        self.assertFalse(any('SIGKILL' in argument for call in calls for argument in call))

    def test_busy_calls_defer_and_shutdown_failure_keeps_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / 'control.sqlite'
            with sqlite3.connect(database) as db:
                db.execute('create table guard(token text)')
            config = root / 'plan.json'
            config.write_text('{}')
            compose = root / 'production-compose.private.json'
            compose.write_text('{}')
            migration = object.__new__(m.Migration)
            migration.directory = root
            migration.args = SimpleNamespace(database=str(database), migration_config=str(config), wait_seconds=0)
            migration.image_id = 'sha256:candidate'
            migration.revision = 'revision'
            migration.state = {'phase': 'rehearsed', 'image': migration.image_id,
                               'planHash': m.sha256(config), 'composeHash': m.sha256(compose)}
            migration.validate = lambda: None
            migration.record = lambda *args, **kwargs: None
            def acquire(db, image, token):
                db.execute('insert into guard values(?)', (token,))
                db.commit()
            def release(db, token):
                db.execute('delete from guard where token=?', (token,))
                db.commit()
            migration.publisher = SimpleNamespace(acquire=acquire, release=release, wait_idle=lambda *a: False)
            with patch.object(Path, 'read_text', return_value='{"phase":"promoted"}'):
                self.assertEqual(migration.cutover(), 75)
                with sqlite3.connect(database) as db:
                    self.assertEqual(db.execute('select count(*) from guard').fetchone()[0], 0)
                migration.publisher.wait_idle = lambda *a: True
                with patch.object(migration, 'graceful_stop', side_effect=RuntimeError('still running')):
                    with self.assertRaisesRegex(RuntimeError, 'still running'):
                        migration.cutover()
                with sqlite3.connect(database) as db:
                    self.assertEqual(db.execute('select count(*) from guard').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
