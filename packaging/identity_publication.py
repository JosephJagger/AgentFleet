"""Paired email-template publication after PostgreSQL cutover; no schema migrations."""
import json
import os
from pathlib import Path
import re

from deployment_provenance import git, image_build, read_receipt, require_ancestor, validate_candidate
from postgres_cutover import atomic_env
from postgres_publication import PostgresPublication


def environment(runtime):
    return dict(item.split('=', 1) for item in runtime['Config'].get('Env', []) if '=' in item)


def validate_identity_scope(root, runtime, source):
    previous = image_build(runtime)
    if not previous:
        raise RuntimeError('Live identity has no source provenance')
    require_ancestor(root, previous, source)
    changed = git(root, 'diff', '--name-only', previous, source, '--', 'apps/identity').splitlines()
    if set(changed) - {'apps/identity/accounts/email.py', 'apps/identity/accounts/tests.py'}:
        raise RuntimeError('Ordinary paired publication supports email-template changes only; identity schema/runtime changes require coordinated maintenance')
    if not environment(runtime).get('DJANGO_DATABASE_URL', '').startswith(('postgres://', 'postgresql://')):
        raise RuntimeError('Paired template publication requires an existing PostgreSQL identity service')


class IdentityPublication:
    def __init__(self, root, image, runtime, run):
        self.root, self.run = Path(root), run
        receipt = read_receipt(root, image['Id'])
        self.image_id = receipt.get('identityImage')
        if not self.image_id:
            raise RuntimeError('--with-identity requires a paired build receipt')
        self.image = json.loads(run('docker', 'image', 'inspect', self.image_id))[0]
        self.runtime = json.loads(run('docker', 'inspect', 'agentfleets-identity-1'))[0]
        validate_identity_scope(root, self.runtime, receipt['source'])
        validate_candidate(root, image, runtime, identity_runtime=self.runtime, identity_image=self.image)
        self.env_path = self.root / '.env'
        self.original_env = self.env_path.read_bytes()
        if os.environ.get('COMPOSE_FILE'):
            raise RuntimeError('Remove shell COMPOSE_FILE override before paired publication')
        self.compose_files = self.runtime['Config'].get('Labels', {}).get('com.docker.compose.project.config_files', '').split(',')
        if not self.compose_files or any(not Path(p).is_absolute() or not Path(p).is_file() for p in self.compose_files):
            raise RuntimeError('Cannot identify existing identity Compose configuration')

    def recheck(self, image, runtime):
        live = json.loads(self.run('docker', 'inspect', 'agentfleets-identity-1'))[0]
        if self.env_path.read_bytes() != self.original_env:
            raise RuntimeError('Production environment changed; rebuild/recheck before publication')
        if environment(live) != environment(self.runtime):
            raise RuntimeError('Identity environment changed during publication')
        validate_candidate(self.root, image, runtime, identity_runtime=live, identity_image=self.image)

    def prepare(self, database, token):
        if not database.config.get('dumpContainer'):
            raise RuntimeError('Paired publication requires a local PostgreSQL dump container')
        backup = PostgresPublication.__new__(PostgresPublication)
        backup.config = {**database.config, 'url': environment(self.runtime)['DJANGO_DATABASE_URL']}
        backup.schema = 'public'
        self.backup_path = database.path.parent / ('identity.postgres.predeploy-' + token + '.dump')
        backup.backup(self.backup_path)
        env_backup = database.path.parent / ('identity.environment.predeploy-' + token)
        fd = os.open(env_backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(self.original_env); stream.flush(); os.fsync(stream.fileno())
        self.override = database.path.parent / ('identity-publication-' + token + '.json')
        with self.override.open('x') as stream:
            json.dump({'services': {'identity': {'image': self.image_id}}}, stream)
        self.files = self.compose_files + [str(self.override)]
        args = [part for p in self.files for part in ('-f', p)]
        config = json.loads(self.run('docker', 'compose', *args, 'config', '--format', 'json'))
        service = config['services']['identity']
        if service.get('image') != self.image_id:
            raise RuntimeError('Compose identity image is not the prepared digest')
        for key in ('DJANGO_DATABASE_URL', 'DJANGO_SECRET_KEY', 'DJANGO_AUTH_SERVICE_TOKEN'):
            if service.get('environment', {}).get(key) != environment(self.runtime).get(key):
                raise RuntimeError('Compose would change identity database or credentials; publication refused')

    def activate(self):
        atomic_env(self.env_path, self.original_env, {'COMPOSE_FILE': ':'.join(self.files)})

    def ready(self, build):
        live = json.loads(self.run('docker', 'inspect', 'agentfleets-identity-1'))[0]
        if live['Image'] != self.image_id or environment(live).get('DJANGO_DATABASE_URL') != environment(self.runtime).get('DJANGO_DATABASE_URL'):
            return False
        try:
            value = json.loads(self.run('docker', 'exec', 'agentfleets-identity-1', 'python', '-c',
                "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).read().decode())"))
            return value.get('status') == 'ok' and value.get('build') == build and value.get('databaseBackend') == 'postgresql'
        except Exception:
            return False
