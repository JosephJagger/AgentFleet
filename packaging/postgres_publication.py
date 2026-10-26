"""PostgreSQL backend for the canonical publisher. This does not perform an engine cutover."""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone


class PostgresPublication:
    def __init__(self, config_path):
        import psycopg
        from psycopg import sql
        path = Path(config_path).resolve(strict=True)
        if path.stat().st_mode & 0o077:
            raise RuntimeError('PostgreSQL publication config must have mode 0600')
        self.config = json.loads(path.read_text())
        self.schema = self.config.get('schema', 'public')
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', self.schema):
            raise RuntimeError('Invalid database schema')
        self.path = Path(self.config['backupDirectory']).resolve() / 'control-plane.postgres'
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = psycopg.connect(self.config['url'], autocommit=True, connect_timeout=10)
        try:
            self.db.execute(sql.SQL('SET search_path TO {}').format(sql.Identifier(self.schema)))
            if self.db.execute('SELECT current_schema()').fetchone()[0] != self.schema:
                raise RuntimeError('PostgreSQL schema is missing')
            if not self.db.execute("SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':agentfleet-publish',0))").fetchone()[0]:
                raise RuntimeError('Another PostgreSQL publisher owns the publication lock')
            if not self.db.execute('SELECT version,sqlite_version FROM agentfleet_schema WHERE singleton=1').fetchone():
                raise RuntimeError('PostgreSQL schema metadata is missing')
        except BaseException:
            self.db.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        # Used by the existing publisher for single-statement writes. Autocommit
        # is deliberate: waiting for calls must not retain a transaction snapshot.
        return False

    def close(self):
        self.db.close()

    def execute(self, statement, parameters=()):
        return self.db.execute(statement.replace('?', '%s'), parameters)

    def counts(self):
        active = {table: self.db.execute(f"SELECT count(*) FROM {table} WHERE state<>'closed'").fetchone()[0]
                  for table in ('panel_voice_calls', 'voice_sessions')}
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        active['ssh_relay_streams'] = self.db.execute('SELECT count(*) FROM ssh_relay_streams WHERE closed_at IS NULL AND last_active_at>%s', (cutoff,)).fetchone()[0]
        return active

    def acquire(self, target, token):
        with self.db.transaction():
            self.db.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':agentfleet-write',0))")
            self.db.execute('INSERT INTO voice_deployment_guard VALUES(1,%s,%s,af_now())', (token, target))

    def fenced(self):
        return bool(self.db.execute('SELECT 1 FROM voice_deployment_guard').fetchone())

    def verify_runtime(self, runtime, status):
        from psycopg.conninfo import conninfo_to_dict
        env = dict(value.split('=', 1) for value in runtime['Config'].get('Env', []) if '=' in value)
        if not env.get('DATABASE_URL'):
            raise RuntimeError('Live service uses SQLite. Initial PostgreSQL cutover requires a separately reviewed coordinated maintenance window.')
        live = conninfo_to_dict(env['DATABASE_URL'])
        target = conninfo_to_dict(self.config['url'])
        if live.get('dbname') != target.get('dbname') or env.get('DATABASE_SCHEMA', 'public') != self.schema:
            raise RuntimeError('Publication database does not match the live service')
        expected = self.config.get('databaseIdentity')
        if (not expected or self.db.execute('SELECT identity FROM agentfleet_database_identity').fetchone()[0] != expected
                or status.get('databaseIdentity') != expected or status.get('databaseBackend') != 'postgresql'):
            raise RuntimeError('Publication config needs the verified live databaseIdentity')
        fence = self.db.execute('SELECT token FROM voice_deployment_guard WHERE singleton=1').fetchone()
        if status.get('voiceDeploymentToken') != (fence[0] if fence else None):
            raise RuntimeError('Live service is not observing this database publication fence')

    def ensure_space(self):
        size = self.db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
        need = size * 12 // 10 + 256 * 2**20
        if shutil.disk_usage(self.path.parent).free < need:
            raise RuntimeError('Not enough free space for PostgreSQL backup')

    def backup(self, destination):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        params = conninfo_to_dict(self.config['url'])
        password = params.pop('password', '')
        env = os.environ.copy()
        env['PGPASSWORD'] = password
        container = self.config.get('dumpContainer')
        if container:
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', container) or '\n' in password:
                raise RuntimeError('Invalid PostgreSQL dump container/configuration')
            params.update(host='127.0.0.1', port='5432')
            command = ['docker', 'exec', '-i', container, 'sh', '-c',
                       'IFS= read -r PGPASSWORD; export PGPASSWORD; exec pg_dump "$@"', 'sh']
        else:
            command = [self.config.get('pgDump', 'pg_dump')]
        command += ['--dbname', make_conninfo(**params), '--format=custom', '--no-owner', '--no-acl', '--schema', self.schema]
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, 'wb') as stream:
                subprocess.run(command, input=(password + '\n').encode() if container else None, env=env,
                               stdout=stream, stderr=subprocess.PIPE, check=True, timeout=3600)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            Path(destination).unlink(missing_ok=True)
            raise RuntimeError('PostgreSQL backup failed; no publication performed') from None


@contextlib.contextmanager
def postgres_database(config):
    db = PostgresPublication(config)
    try:
        yield db.path, db
    finally:
        db.close()
