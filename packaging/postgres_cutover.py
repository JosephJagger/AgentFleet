"""Initial database-engine cutover, entered only by the canonical publisher.

Both services are built from one clean main commit. Other tasks, voice calls and
SSH streams must be idle. A SQLite writer lock closes the check/stop race. Source
snapshots, key digests and an explicit journal survive every failure. Once either
new service can accept traffic, SQLite rollback is forbidden.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import uuid

from deployment_provenance import git, read_receipt, registry, require_active_host, require_ancestor, validate_candidate
from host_migration import private_json, sha256, snapshot_database
from postgres_publication import PostgresPublication


def active_work(db, controller=None):
    return {
        'otherExecutingSessions': db.execute("""SELECT count(*) FROM logical_sessions
            WHERE deleted_at IS NULL AND (active_turn_id IS NOT NULL OR execution_state IN ('running','awaiting_approval'))
            AND logical_session_id<>?""", (controller or '',)).fetchone()[0],
        'otherPendingCommands': db.execute("""SELECT count(*) FROM command_projection p JOIN commands c USING(command_id)
            WHERE p.state NOT IN ('applied','invalidated','rejected','cancelled','expired','failed')
            AND c.logical_session_id<>?""", (controller or '',)).fetchone()[0],
    }


def source_database(runtime, variable):
    env = dict(item.split('=', 1) for item in runtime['Config']['Env'] if '=' in item)
    path = Path(env[variable])
    for mount in sorted(runtime['Mounts'], key=lambda m: -len(m['Destination'])):
        if path.is_relative_to(mount['Destination']):
            return (Path(mount['Source']) / path.relative_to(mount['Destination'])).resolve()
    raise RuntimeError('Live database is not on an identified persistent mount')


def atomic_env(path, original, updates):
    if path.read_bytes() != original:
        raise RuntimeError('Production environment changed during preparation; no overwrite performed')
    lines = [line for line in original.decode().splitlines()
             if not any(re.match(r'^(?:export\s+)?' + re.escape(key) + r'=', line) for key in updates)]
    text = '\n'.join(lines) + '\n' + '\n'.join(key + '=' + json.dumps(value) for key, value in updates.items()) + '\n'
    temporary = path.with_name(path.name + '.postgres-cutover.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(text); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


class EngineCutover:
    def __init__(self, root, args, publisher):
        self.root, self.args, self.publisher = Path(root), args, publisher
        path = Path(args.engine_config).resolve(strict=True)
        if path.stat().st_mode & 0o077:
            raise RuntimeError('Engine configuration must have mode 0600')
        self.plan = json.loads(path.read_text())
        self.directory = Path(self.plan['directory']).resolve(strict=True)
        if self.directory.stat().st_mode & 0o077:
            raise RuntimeError('Cutover directory must be private')
        self.journal = self.directory / 'cutover.json'
        self.state = json.loads(self.journal.read_text()) if self.journal.exists() else {}
        self.schema = self.plan['schema']
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', self.schema) or self.schema in ('public','information_schema') or self.schema.startswith('pg_'):
            raise RuntimeError('Use a new dedicated PostgreSQL schema')
        self.path = Path(args.database).resolve(strict=True)
        self.image = self.inspect(args.image, image=True)
        self.receipt = read_receipt(root, self.image['Id'])
        if not self.receipt.get('identityImage'): raise RuntimeError('Engine cutover requires a paired --with-identity build')
        self.identity_image = self.inspect(self.receipt['identityImage'], image=True)
        self.source = self.inspect('agentfleet-control-plane')
        self.identity_source = self.inspect('agentfleets-identity-1')

    def inspect(self, name, image=False):
        return json.loads(self.publisher.run('docker', *(['image'] if image else []), 'inspect', name))[0]

    def record(self, phase, **values):
        self.state.update(phase=phase, source=self.receipt['source'], image=self.image['Id'], updatedAt=time.time(), **values)
        private_json(self.journal, self.state)
        print(json.dumps({'enginePhase': phase}), flush=True)

    def validate_images(self):
        require_active_host(self.root)
        return validate_candidate(self.root, self.image, self.inspect('agentfleet-control-plane'),
            identity_runtime=self.inspect('agentfleets-identity-1'), identity_image=self.identity_image)

    def credentials(self, key):
        path = Path(self.plan[key]).resolve(strict=True)
        if path.stat().st_mode & 0o077:
            raise RuntimeError('Connection files must have mode 0600')
        return json.loads(path.read_text())['url']

    def preflight(self, db):
        import psycopg
        self.validate_images()
        if not self.source['State']['Running'] or not self.identity_source['State']['Running']:
            raise RuntimeError('Both source services must be running before a fresh cutover')
        if self.path != source_database(self.source, 'DATABASE_PATH'):
            raise RuntimeError('SQLite source differs from the actual running control plane')
        self.identity_path = source_database(self.identity_source, 'DJANGO_DATABASE_PATH')
        env = dict(v.split('=',1) for v in self.source['Config']['Env'] if '=' in v)
        if env.get('DATABASE_URL'):
            raise RuntimeError('Engine cutover requires a live SQLite source')
        if db.execute('PRAGMA user_version').fetchone()[0] != 72:
            raise RuntimeError('SQLite source must have schema version 72')
        controller = self.plan.get('controllerSession')
        if controller:
            row = db.execute('SELECT session_cwd FROM logical_sessions WHERE logical_session_id=?', (controller,)).fetchone()
            if not row or row[0] != self.plan.get('controllerWorktree'):
                raise RuntimeError('Controller exclusion must identify this migration task exactly')
        if re.search(r'^(?:export\s+)?COMPOSE_FILE=', (self.root / '.env').read_text(), re.M):
            raise RuntimeError('Existing Compose overrides require reconciliation before initial engine cutover')
        compose = json.loads(self.publisher.run('docker','compose','config','--format','json'))
        for service, runtime, keys in [
            ('control-plane',self.source,['PUBLIC_ORIGIN','ADMIN_EMAIL','DATABASE_PATH','DJANGO_AUTH_URL','DJANGO_AUTH_SERVICE_TOKEN']),
            ('identity',self.identity_source,['DJANGO_SECRET_KEY','DJANGO_AUTH_SERVICE_TOKEN','DJANGO_DATABASE_PATH','RESEND_API_KEY'])]:
            actual = dict(v.split('=',1) for v in runtime['Config']['Env'] if '=' in v)
            if any(str(compose['services'][service]['environment'].get(k,'')) != actual.get(k,'') for k in keys):
                raise RuntimeError('Compose configuration differs from the live ' + service)
        self.publisher.run('docker','network','inspect',self.plan['postgresNetwork'])
        with psycopg.connect(self.credentials('controlConnection')) as target:
            if target.execute('SELECT 1 FROM pg_namespace WHERE nspname=%s',(self.schema,)).fetchone():
                raise RuntimeError('Target schema already exists; refusing to overwrite it')
        with psycopg.connect(self.credentials('identityConnection')) as target:
            if target.execute("SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1").fetchone():
                raise RuntimeError('Target identity database must be empty')
        for filename in ('writing-ai.key','ssh-access.key'):
            path = self.path.parent / filename
            if not path.is_file(): raise RuntimeError('Required encryption key is missing: ' + filename)
        self.publisher.ensure_backup_space(self.path)

    def container_job(self, image, command, label, *, env_file=None):
        # SQLite's ordered checksum scan can spill well beyond the small /tmp
        # tmpfs. Keep its temporary files on the private, space-checked disk.
        (self.directory / 'sqlite-tmp').mkdir(mode=0o700, exist_ok=True)
        # Service-owned package directories may be mode 0700 in the image.
        # The root importer needs read access while the image stays read-only.
        argv = ['docker','run','--rm','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_OVERRIDE',
                '--network',self.plan['postgresNetwork'],'--tmpfs','/tmp:size=64m',
                '-e','SQLITE_TMPDIR=/migration/sqlite-tmp',
                '-v',str(self.directory)+':/migration']
        if env_file: argv += ['--env-file',str(env_file)]
        argv += ['--entrypoint',command[0],image,*command[1:]]
        fd = os.open(self.directory / (label + '.log'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd,'w') as log:
            result = subprocess.run(argv,cwd=self.root,stdout=log,stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(label + ' failed; inspect its private log. Source services remain stopped.')

    def migrate(self):
        import psycopg
        from psycopg import sql
        snapshots = {
            'control': snapshot_database(self.path,self.directory/'control.sqlite'),
            'identity': snapshot_database(self.identity_path,self.directory/'identity.sqlite'),
        }
        self.record('snapshots_verified', snapshots=snapshots)
        private_json(self.directory/'runtime-control.json', {'url':self.credentials('controlRuntimeConnection')})
        self.container_job(self.image['Id'], ['node','/app/control-plane/dist/src/migrate-postgres-cli.js',
            '--snapshot','/migration/control.sqlite','--connection-file','/migration/runtime-control.json',
            '--schema',self.schema,'--report','/migration/control-import.json','--apply'], 'control-import')
        identity_env = dict(v.split('=',1) for v in self.identity_source['Config']['Env'] if '=' in v)
        values = {key:identity_env[key] for key in ('DJANGO_SECRET_KEY','DJANGO_AUTH_SERVICE_TOKEN')}
        values['DJANGO_DATABASE_URL'] = self.plan['identityRuntimeUrl']
        if any('\n' in value or '\r' in value for value in values.values()): raise RuntimeError('Invalid multiline environment value')
        env_file = self.directory/'identity-import.env'
        fd=os.open(env_file,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as stream: stream.write('\n'.join(k+'='+v for k,v in values.items())+'\n')
        self.container_job(self.identity_image['Id'], ['python','manage.py','migrate','--noinput'],'identity-schema',env_file=env_file)
        self.container_job(self.identity_image['Id'], ['python','manage.py','import_sqlite','--snapshot','/migration/identity.sqlite',
            '--report','/migration/identity-import.json','--apply'],'identity-import',env_file=env_file)
        with psycopg.connect(self.credentials('controlConnection')) as target:
            identity = target.execute(sql.SQL('SELECT identity FROM {}.agentfleet_database_identity').format(sql.Identifier(self.schema))).fetchone()[0]
            fence = target.execute(sql.SQL('SELECT token FROM {}.voice_deployment_guard').format(sql.Identifier(self.schema))).fetchone()[0]
            if fence != self.state['token']: raise RuntimeError('Imported publication fence does not match')
        self.record('imports_verified', databaseIdentity=identity)
        config={'url':self.credentials('controlConnection'),'schema':self.schema,'databaseIdentity':identity,
                'backupDirectory':str(self.directory/'backups'),'dumpContainer':self.plan['postgresContainer']}
        private_json(self.directory/'publication.json',config)
        return PostgresPublication(self.directory/'publication.json')

    def open_traffic(self, pg, *, resume=False):
        self.validate_images()
        for name in ('agentfleet-control-plane','agentfleets-identity-1'):
            if self.inspect(name)['State']['Running']: raise RuntimeError('A source writer restarted during migration')
        before=(self.directory/'environment.before').read_bytes()
        if resume:
            if sha256(self.root/'.env') != self.state.get('configuredEnvironment'):
                raise RuntimeError('Production environment changed after the failed start; refusing to overwrite it')
            before=(self.root/'.env').read_bytes()
        compose=json.loads(self.publisher.run('docker','compose','config','--format','json'))
        default_network=compose['networks']['default']['name']
        if default_network not in self.source['NetworkSettings']['Networks']:
            raise RuntimeError('Default Compose network differs from the source control plane')
        override=self.directory/'compose.postgres.json'
        private_json(override, {'services': {
            'control-plane': {'networks':['default','postgres']},
            'identity': {'image':self.identity_image['Id'],'networks':['default','postgres']}},
            'networks': {'default': {'external':True,'name':default_network},
                         'postgres': {'external':True,'name':self.plan['postgresNetwork']}}})
        atomic_env(self.root/'.env',before, {'DATABASE_URL':self.credentials('controlRuntimeConnection'),
            'DATABASE_SCHEMA':self.schema,'DJANGO_DATABASE_URL':self.plan['identityRuntimeUrl'],
            'COMPOSE_FILE':str(self.root/'docker-compose.yml')+':'+str(override)})
        self.record('environment_configured', configuredEnvironment=sha256(self.root/'.env'))
        self.publisher.run('docker','tag',self.image['Id'],'agentfleet:local')
        self.record('traffic_starting', trafficAttempted=True)
        private_json(registry(self.root)/'database-owner.json', {'engine':'postgresql','source':self.receipt['source'],
            'databaseIdentity':self.state['databaseIdentity'],'retiredSqlite':[str(self.path),str(self.identity_path)],
            'publicationConfig':str(self.directory/'publication.json')})
        self.publisher.run('docker','compose','up','-d','--no-deps','--no-build','identity')
        deadline=time.monotonic()+90
        while True:
            try:
                status=json.loads(self.publisher.run('docker','exec','agentfleets-identity-1','python','-c',
                    "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).read().decode())"))
                if status.get('status')=='ok' and status.get('build')==self.receipt['source'] and status.get('databaseBackend')=='postgresql': break
            except subprocess.CalledProcessError: pass
            if time.monotonic()>deadline: raise RuntimeError('New identity readiness not verified; no SQLite rollback allowed')
            time.sleep(2)
        self.publisher.run('docker','compose','up','-d','--no-deps','--no-build','control-plane')
        deadline=time.monotonic()+90
        while True:
            try:
                status=self.publisher.health(self.args.ready_url)
                pg.verify_runtime(self.inspect('agentfleet-control-plane'),status)
                if status.get('status')=='ok' and status.get('build')==self.receipt['source'] and status.get('voiceDeploymentToken')==self.state['token']: break
            except (OSError,ValueError,RuntimeError): pass
            if time.monotonic()>deadline: raise RuntimeError('New control plane readiness not verified; fence retained')
            time.sleep(2)
        self.publisher.run('node',str(self.root/'packaging/verify-published-installers.mjs'),self.state['publicOrigin'],self.state['installerVersion'])
        self.publisher.release(pg,self.state['token'])
        status=self.publisher.health(self.args.ready_url)
        if status.get('voiceDeploymentToken') is not None or status.get('build')!=self.receipt['source']:
            raise RuntimeError('Admission reopening was not verified; inspect the live PostgreSQL service')
        self.record('published', ready=status)

    def resume_stopped_import(self):
        """Recover a failed first startup without reopening SQLite or reimporting."""
        if self.state.get('phase') != 'traffic_starting' or not self.state.get('trafficAttempted'):
            raise RuntimeError('Recovery requires a verified import and a failed traffic startup')
        for key,name in [('sourceContainer','agentfleet-control-plane'),('identityContainer','agentfleets-identity-1')]:
            runtime=self.inspect(name)
            if runtime['Id'] != self.state[key] or runtime['State']['Running']:
                raise RuntimeError('Recovery requires both original containers to remain stopped and unchanged')
        self.validate_images()
        require_ancestor(self.root,self.state['source'],self.receipt['source'])
        if git(self.root,'diff','--name-only',self.state['source'],self.receipt['source'],'--','apps','docker-compose.yml'):
            raise RuntimeError('Application sources changed after import; this recovery only permits publisher fixes')
        owner=json.loads((registry(self.root)/'database-owner.json').read_text())
        if owner.get('engine')!='postgresql' or owner.get('databaseIdentity')!=self.state['databaseIdentity']:
            raise RuntimeError('Database ownership record does not match the imported database')
        if any(sha256(self.path.parent/name)!=value for name,value in self.state['keys'].items()):
            raise RuntimeError('An encryption key changed after import')
        with contextlib.closing(PostgresPublication(self.directory/'publication.json')) as pg:
            identity=pg.execute('SELECT identity FROM agentfleet_database_identity').fetchone()[0]
            fence=pg.execute('SELECT token FROM voice_deployment_guard WHERE singleton=1').fetchone()
            if identity!=self.state['databaseIdentity'] or not fence or fence[0]!=self.state['token']:
                raise RuntimeError('Imported database identity or admission fence changed')
            self.state.setdefault('importedSource',self.state['source'])
            self.open_traffic(pg,resume=True)
        return 0

    def cutover(self, db):
        if self.state: raise RuntimeError('Cutover journal already exists; inspect it or explicitly abort before traffic')
        active={**self.publisher.counts(db),**active_work(db,self.plan.get('controllerSession'))}
        if any(active.values()):
            print(json.dumps({'enginePhase':'deferred','active':active}),flush=True);return 75
        self.preflight(db)
        env=dict(v.split('=',1) for v in self.source['Config']['Env'] if '=' in v)
        version=self.publisher.run('docker','run','--rm','--entrypoint','node',self.image['Id'],'-e',
            "console.log(JSON.parse(require('node:fs').readFileSync('/app/web/downloads/manifest.json')).version)")
        token=uuid.uuid4().hex
        self.publisher.acquire(db,self.image['Id'],token)
        stopped=False
        try:
            db.execute('BEGIN IMMEDIATE')
            active={**self.publisher.counts(db),**active_work(db,self.plan.get('controllerSession'))}
            if any(active.values()):
                print(json.dumps({'enginePhase':'deferred','active':active}),flush=True);return 75
            self.validate_images()
            original=(self.root/'.env').read_bytes()
            fd=os.open(self.directory/'environment.before',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'wb') as stream: stream.write(original)
            self.record('stopping_writers',token=token,sourceContainer=self.source['Id'],identityContainer=self.identity_source['Id'],
                originalImage=self.source['Image'],publicOrigin=env['PUBLIC_ORIGIN'],installerVersion=version,
                keys={name:sha256(self.path.parent/name) for name in ('writing-ai.key','ssh-access.key')})
            stopped=True  # Any partial stop requires explicit recovery, never implicit rollback.
            self.publisher.run('docker','compose','stop','--timeout','30','control-plane','identity')
            if any(self.inspect(name)['State']['Running'] for name in ('agentfleet-control-plane','agentfleets-identity-1')):
                raise RuntimeError('Source writers did not stop; snapshots were not taken')
        finally:
            if db.in_transaction: db.rollback()
            if not stopped: self.publisher.release(db,token)
        self.record('writers_stopped')
        with contextlib.closing(self.migrate()) as pg:
            pg.ensure_space();pg.backup(pg.path.parent/'initial-import.dump')
            if any(sha256(self.path.parent/name)!=value for name,value in self.state['keys'].items()):
                raise RuntimeError('An encryption key changed during migration')
            self.open_traffic(pg)
        return 0

    def abort(self, db):
        if not self.state or self.state.get('trafficAttempted'):
            raise RuntimeError('No pre-traffic cutover can be aborted; never roll back accepted PostgreSQL writes')
        for key,name in [('sourceContainer','agentfleet-control-plane'),('identityContainer','agentfleets-identity-1')]:
            if self.inspect(name)['Id']!=self.state[key]: raise RuntimeError('Source container changed; automatic recovery refused')
        before=(self.directory/'environment.before').read_bytes()
        # Only our known environment may be restored. Unrelated edits require reconciliation.
        current=(self.root/'.env').read_bytes()
        if current!=before:
            if sha256(self.root/'.env')!=self.state.get('configuredEnvironment'):
                raise RuntimeError('Environment changed outside this cutover; reconcile it before aborting')
            temporary=self.directory/'environment.restore'
            fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'wb') as stream: stream.write(before);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,self.root/'.env')
        self.publisher.run('docker','tag',self.state['originalImage'],'agentfleet:local')
        self.publisher.run('docker','start',self.state['identityContainer'],self.state['sourceContainer'])
        deadline=time.monotonic()+90
        while True:
            try:
                if self.publisher.health(self.args.ready_url).get('status')=='ok': break
            except OSError: pass
            if time.monotonic()>deadline: raise RuntimeError('Original service readiness not verified; fence retained')
            time.sleep(2)
        self.publisher.release(db,self.state['token']);self.record('aborted_before_traffic');return 0


def run_cutover(root,args,publisher):
    operation=EngineCutover(root,args,publisher)
    require_active_host(root)
    with open(str(operation.path)+'.publish.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with contextlib.closing(sqlite3.connect(operation.path.as_uri()+'?mode=rw',uri=True,timeout=10)) as db:
            if args.engine_phase=='resume-stopped-import': return operation.resume_stopped_import()
            if args.engine_phase=='abort-before-traffic': return operation.abort(db)
            if args.engine_phase=='check':
                operation.preflight(db)
                print(json.dumps({'enginePhase':'checked','active':{**publisher.counts(db),**active_work(db,operation.plan.get('controllerSession'))}}));return 0
            return operation.cutover(db)
