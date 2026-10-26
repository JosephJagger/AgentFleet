import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from postgres_cutover import EngineCutover, active_work, atomic_env, source_database


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE logical_sessions(logical_session_id TEXT,deleted_at TEXT,active_turn_id TEXT,execution_state TEXT);
            CREATE TABLE commands(command_id TEXT,logical_session_id TEXT);
            CREATE TABLE command_projection(command_id TEXT,state TEXT);''')

    def test_controller_exclusion_never_excludes_other_sessions_or_pending_commands(self):
        self.db.execute("INSERT INTO logical_sessions VALUES('controller',NULL,'turn','running'),('other',NULL,NULL,'awaiting_approval')")
        self.db.execute("INSERT INTO commands VALUES('c1','controller'),('c2','other')")
        self.db.execute("INSERT INTO command_projection VALUES('c1','accepted'),('c2','unknown')")
        self.assertEqual(active_work(self.db,'controller'),{'otherExecutingSessions':1,'otherPendingCommands':1})
        self.assertEqual(active_work(self.db)['otherExecutingSessions'],2)

    def operation(self):
        operation=EngineCutover.__new__(EngineCutover)
        operation.state={};operation.plan={};operation.image={'Id':'candidate'}
        operation.source={'Config':{'Env':['PUBLIC_ORIGIN=https://example.test']}}
        operation.publisher=SimpleNamespace(counts=lambda db: {'voice':0,'ssh':0},acquire=Mock(),release=Mock(),run=Mock(return_value='1.0'))
        operation.preflight=Mock();operation.validate_images=Mock();operation.record=Mock()
        return operation

    def test_active_work_defers_without_fence_or_service_operations(self):
        self.db.execute("INSERT INTO logical_sessions VALUES('other',NULL,'turn','running')")
        operation=self.operation()
        self.assertEqual(operation.cutover(self.db),75)
        operation.preflight.assert_not_called();operation.publisher.acquire.assert_not_called()
        operation.publisher.run.assert_not_called();operation.record.assert_not_called()

    def test_task_arriving_between_preflight_and_writer_lock_prevents_stop(self):
        operation=self.operation()
        def acquire(*args):
            self.db.execute("INSERT INTO logical_sessions VALUES('new',NULL,'turn','running')");self.db.commit()
        operation.publisher.acquire.side_effect=acquire
        self.assertEqual(operation.cutover(self.db),75)
        operation.publisher.release.assert_called_once()
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(len(operation.publisher.run.call_args_list),1)  # Read the installer's version only.
        operation.record.assert_not_called()

    def test_any_postgres_traffic_attempt_forbids_sqlite_abort(self):
        operation=self.operation();operation.state={'trafficAttempted':True}
        with self.assertRaisesRegex(RuntimeError,'never roll back'): operation.abort(self.db)
        operation.publisher.run.assert_not_called()

    def test_source_database_is_derived_from_the_running_persistent_mount(self):
        runtime={'Config':{'Env':['DATABASE_PATH=/app/data/control.sqlite']},'Mounts':[{'Destination':'/app/data','Source':'/actual/data'}]}
        self.assertEqual(source_database(runtime,'DATABASE_PATH'),Path('/actual/data/control.sqlite'))
        runtime['Mounts']=[]
        with self.assertRaisesRegex(RuntimeError,'persistent mount'): source_database(runtime,'DATABASE_PATH')

    def test_environment_update_preserves_unrelated_settings_and_refuses_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'.env';original=b'EXISTING=keep\nDATABASE_URL=old\n'
            path.write_bytes(original)
            atomic_env(path,original,{'DATABASE_URL':'postgresql://example','DATABASE_SCHEMA':'app'})
            self.assertIn('EXISTING=keep',path.read_text());self.assertNotIn('DATABASE_URL=old',path.read_text())
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            before=path.read_bytes()
            with self.assertRaisesRegex(RuntimeError,'changed'): atomic_env(path,original,{'DATABASE_URL':'different'})
            self.assertEqual(path.read_bytes(),before)


if __name__=='__main__': unittest.main()
