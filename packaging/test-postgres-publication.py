"""Real PostgreSQL publication-backend checks. Never invoke Docker publication/restart."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

from postgres_publication import PostgresPublication

CONFIG = os.getenv('AGENTFLEET_TEST_PG_CONFIG')


@unittest.skipUnless(CONFIG, 'Set AGENTFLEET_TEST_PG_CONFIG to an isolated test database')
class PostgresPublicationTests(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.url = json.loads(Path(CONFIG).read_text())['url']
        self.schema = 'af_test_pub_' + uuid.uuid4().hex
        self.client = psycopg.connect(self.url, autocommit=True)
        self.addCleanup(self.client.close)
        self.client.execute(f'CREATE SCHEMA {self.schema}')
        self.addCleanup(lambda: self.client.execute(f'DROP SCHEMA {self.schema} CASCADE'))
        self.client.execute(f'SET search_path TO {self.schema}')
        self.client.execute('''CREATE TABLE agentfleet_schema(singleton integer,version integer,sqlite_version integer);
            INSERT INTO agentfleet_schema VALUES(1,1,72);
            CREATE TABLE agentfleet_database_identity(identity text); INSERT INTO agentfleet_database_identity VALUES('fixture');
            CREATE TABLE voice_deployment_guard(singleton integer PRIMARY KEY,token text,target text,created_at text);
            CREATE TABLE panel_voice_calls(state text); CREATE TABLE voice_sessions(state text);
            CREATE TABLE ssh_relay_streams(closed_at text,last_active_at text);
            CREATE FUNCTION af_now() RETURNS text LANGUAGE sql AS $$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;''')
        self.path = self.root / 'publication.json'
        self.config = {'url': self.url, 'schema': self.schema, 'backupDirectory': str(self.root), 'databaseIdentity': 'fixture'}
        if os.getenv('AGENTFLEET_TEST_PG_CONTAINER'):
            self.config['dumpContainer'] = os.environ['AGENTFLEET_TEST_PG_CONTAINER']
        self.path.write_text(json.dumps(self.config)); self.path.chmod(0o600)
        self.db = PostgresPublication(self.path)
        self.addCleanup(self.db.close)

    def test_publication_lock_fence_and_live_database_identity(self):
        with self.assertRaisesRegex(RuntimeError, 'Another PostgreSQL publisher'):
            PostgresPublication(self.path)
        self.db.acquire('sha256:fixture', 'owner')
        self.assertTrue(self.db.fenced())
        # An independent connection sees the durable admission fence immediately.
        self.assertEqual(self.client.execute('SELECT token FROM voice_deployment_guard').fetchone()[0], 'owner')
        runtime = {'Config': {'Env': ['DATABASE_URL=' + self.url, 'DATABASE_SCHEMA=' + self.schema]}}
        status = {'databaseBackend': 'postgresql', 'databaseIdentity': 'fixture', 'voiceDeploymentToken': 'owner'}
        self.db.verify_runtime(runtime, status)
        with self.assertRaisesRegex(RuntimeError, 'fence'):
            self.db.verify_runtime(runtime, {**status, 'voiceDeploymentToken': None})
        with self.assertRaisesRegex(RuntimeError, 'Live service uses SQLite'):
            self.db.verify_runtime({'Config': {'Env': []}}, status)
        self.db.execute('DELETE FROM voice_deployment_guard WHERE token=?', ('wrong',))
        self.assertTrue(self.db.fenced())
        self.db.execute('DELETE FROM voice_deployment_guard WHERE token=?', ('owner',))
        self.assertFalse(self.db.fenced())

    def test_voice_and_relay_drain_counts(self):
        self.client.execute("INSERT INTO panel_voice_calls VALUES('active'),('closed'); INSERT INTO voice_sessions VALUES('closing'); INSERT INTO ssh_relay_streams VALUES(NULL,af_now()),(NULL,'2000-01-01T00:00:00.000Z')")
        self.assertEqual(self.db.counts(), {'panel_voice_calls': 1, 'voice_sessions': 1, 'ssh_relay_streams': 1})

    def test_dump_is_private_and_restoreable(self):
        if not self.config.get('dumpContainer'):
            self.skipTest('Set AGENTFLEET_TEST_PG_CONTAINER for the container pg_dump integration test')
        import subprocess
        target = self.root / 'backup.dump'
        self.db.backup(target)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.read_bytes()[:5], b'PGDMP')
        result = subprocess.run(['docker', 'exec', '-i', self.config['dumpContainer'], 'pg_restore', '--list'], input=target.read_bytes(), capture_output=True, check=True)
        self.assertIn(b'voice_deployment_guard', result.stdout)


if __name__ == '__main__':
    unittest.main()
