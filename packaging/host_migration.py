"""Controlled single-writer host handoff, entered only through the canonical publisher.

The source holds both publication locks. The destination remains gated until all
source writers have stopped and verified snapshots have arrived. Failures retain
the durable fence; only a pre-traffic handoff can be explicitly aborted here.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import sqlite3
import subprocess
import time
import uuid

from deployment_provenance import registry, require_active_host, validate_candidate


def execute(argv, **kwargs):
    return subprocess.check_output(argv, text=True, **kwargs).strip()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)
    os.replace(temporary, path)


def snapshot_database(source, target):
    """Use SQLite's backup API, including committed WAL pages; never copy a live DB."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_name(target.name + '.tmp')
    if temporary.exists():
        temporary.unlink()
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        with contextlib.closing(sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True)) as src:
            with contextlib.closing(sqlite3.connect(temporary)) as dst:
                src.backup(dst)
                if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise RuntimeError('Snapshot integrity check failed')
                tables = [r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                counts = {t: dst.execute('SELECT count(*) FROM "' + t.replace('"', '""') + '"').fetchone()[0]
                          for t in tables}
        os.replace(temporary, target)
        return {'sha256': sha256(target), 'bytes': target.stat().st_size, 'tables': counts}
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def validate_inventory(plan):
    if plan['sourceHost'] != socket.gethostname():
        raise RuntimeError('Migration inventory belongs to another source host')
    if plan['sourceHost'] == plan['targetHost']:
        raise RuntimeError('Source and target must differ')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', plan['sshAlias']):
        raise RuntimeError('Invalid SSH alias')
    if not Path(plan['targetRoot']).is_absolute() or not Path(plan['directory']).is_absolute():
        raise RuntimeError('Migration paths must be absolute')
    names = [c['Name'].lstrip('/') for c in plan['containers']]
    if len(set(names)) != len(names) or 'agentfleet-control-plane' not in names:
        raise RuntimeError('Invalid service inventory')
    for pair in plan['syncDirectories']:
        if not Path(pair['source']).is_absolute() or not Path(pair['target']).is_absolute():
            raise RuntimeError('Sync paths must be absolute')


def compose_spec(plan, image, revision):
    services = {}
    names = {'agentfleet-control-plane': 'control-plane', 'agentfleet-runtime-validator': 'runtime-validator',
             'agentfleets-identity-1': 'identity', 'agentfleet-www': 'website',
             'applefleets-renderer': 'renderer', 'agentfleet-video-storage': 'video-storage'}
    volumes = {}
    for container in plan['containers']:
        name = container['Name'].lstrip('/')
        config, host = container['Config'], container['HostConfig']
        panel = name in ('agentfleet-control-plane', 'agentfleet-runtime-validator')
        env = dict(entry.split('=', 1) for entry in config.get('Env', []))
        if panel:
            env['AGENTFLEET_BUILD_SHA'] = revision
        service = {'container_name': name, 'image': image if panel else container['Image'],
                   'restart': 'unless-stopped', 'environment': env,
                   'read_only': host.get('ReadonlyRootfs', False)}
        for source, dest in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            if config.get(source):
                service[dest] = config[source]
        if host.get('SecurityOpt'):
            service['security_opt'] = host['SecurityOpt']
        if host.get('CapDrop'):
            service['cap_drop'] = host['CapDrop']
        if host.get('Memory'):
            service['mem_limit'] = host['Memory']
        if host.get('PidsLimit') and host['PidsLimit'] > 0:
            service['pids_limit'] = host['PidsLimit']
        if host.get('NanoCpus'):
            service['cpus'] = host['NanoCpus'] / 1e9
        if host.get('Tmpfs'):
            service['tmpfs'] = [p + ':' + value for p, value in host['Tmpfs'].items()]
        service['volumes'] = []
        for mount in container['Mounts']:
            source = mount['Name'] if mount['Type'] == 'volume' else mount['Source']
            service['volumes'].append({'type': mount['Type'], 'source': source,
                                      'target': mount['Destination'], 'read_only': not mount['RW']})
            if mount['Type'] == 'volume':
                volumes[source] = {'external': True, 'name': source}
        ports = []
        for target, bindings in (host.get('PortBindings') or {}).items():
            for binding in bindings or []:
                if binding['HostIp'] not in ('127.0.0.1', '::1'):
                    raise RuntimeError('Migration requires loopback-only service ports: ' + name)
                ports.append(binding['HostIp'] + ':' + binding['HostPort'] + ':' + target)
        if ports:
            service['ports'] = ports
        if config.get('Healthcheck'):
            h = config['Healthcheck']
            service['healthcheck'] = {'test': h['Test']}
            for old, new in [('Interval', 'interval'), ('Timeout', 'timeout'), ('StartPeriod', 'start_period')]:
                if h.get(old):
                    service['healthcheck'][new] = str(h[old]) + 'ns'
            if h.get('Retries'):
                service['healthcheck']['retries'] = h['Retries']
        services[names[name]] = service
    services['control-plane']['depends_on'] = {'identity': {'condition': 'service_healthy'},
                                              'runtime-validator': {'condition': 'service_started'}}
    return {'name': 'agentfleets', 'services': services, 'volumes': volumes,
            'networks': {'default': {'name': 'agentfleets_default',
                                    'ipam': {'config': [{'subnet': plan['networkSubnet']}]}}}}


class Migration:
    def __init__(self, root, args, publisher):
        self.root, self.args, self.publisher = root, args, publisher
        self.plan = json.loads(Path(args.migration_config).read_text())
        validate_inventory(self.plan)
        self.directory = Path(self.plan['directory'])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.journal = self.directory / 'handoff.json'
        self.target = self.plan['sshAlias']
        self.image = json.loads(execute(['docker', 'image', 'inspect', args.image]))[0]
        self.image_id = self.image['Id']
        self.source = json.loads(execute(['docker', 'inspect', 'agentfleet-control-plane']))[0]
        self.names = [c['Name'].lstrip('/') for c in self.plan['containers']]
        self.state = json.loads(self.journal.read_text()) if self.journal.exists() else {}

    def remote(self, *args, **kwargs):
        return execute(['ssh', '-o', 'BatchMode=yes', self.target, shlex.join(args)], **kwargs)

    def copy(self, source, target, *options):
        subprocess.run(['rsync', '-aHAX', '--numeric-ids', *options, str(source),
                        self.target + ':' + str(target)], check=True, stdout=subprocess.DEVNULL)

    def record(self, phase, **values):
        if getattr(self, 'target_lock', None) is not None and self.target_lock.poll() is not None:
            raise RuntimeError('Target publication lock connection was lost')
        self.state.update(phase=phase, image=self.image_id, sourceHost=self.plan['sourceHost'],
                          targetHost=self.plan['targetHost'], updatedAt=time.time(), **values)
        private_json(self.journal, self.state)
        self.copy(self.journal, self.journal)
        print(json.dumps({'migrationPhase': phase, 'target': self.plan['targetHost']}), flush=True)

    def validate(self):
        require_active_host(self.root)
        current = json.loads(execute(['docker', 'inspect', 'agentfleet-control-plane']))[0]
        candidate = validate_candidate(self.root, self.image, current)
        if self.remote('hostname') != self.plan['targetHost']:
            raise RuntimeError('SSH target hostname mismatch')
        target_root = self.plan['targetRoot']
        if self.remote('git', '-C', target_root, 'rev-parse', 'HEAD') != candidate['source']:
            raise RuntimeError('Target main differs from prepared source')
        if self.remote('git', '-C', target_root, 'symbolic-ref', '--short', 'HEAD') != 'main':
            raise RuntimeError('Target must be on main')
        if self.remote('git', '-C', target_root, 'status', '--porcelain', '--untracked-files=all'):
            raise RuntimeError('Target main is dirty')
        target_image = json.loads(self.remote('docker', 'image', 'inspect', self.image_id))[0]
        if target_image['Config']['Labels'] != self.image['Config']['Labels']:
            raise RuntimeError('Target image metadata mismatch')
        for image_id in [self.image_id, current['Image']]:
            local = registry(self.root) / 'images' / (image_id[7:] + '.json')
            remote = Path(target_root) / '.git/agentfleet-releases/images' / local.name
            if self.remote('sha256sum', str(remote)).split()[0] != sha256(local):
                raise RuntimeError('Target build receipt mismatch')
        for c in self.plan['containers']:
            runtime = json.loads(execute(['docker', 'inspect', c['Name']]))[0]
            if runtime['Id'] != c['Id'] or runtime['Image'] != c['Image'] or not runtime['State']['Running']:
                raise RuntimeError('Source service changed: ' + c['Name'])
            self.remote('docker', 'image', 'inspect', c['Image'])
        present = set(self.remote('docker', 'ps', '-a', '--format', '{{.Names}}').splitlines())
        if present.intersection(self.names):
            raise RuntimeError('Destination production services already exist; inspect the handoff journal')
        if self.remote('test', '-f', self.plan['targetGate']) != '':
            raise RuntimeError('Target ingress must be gated')
        self.revision = candidate['source']
        return candidate

    def save_compose(self):
        path = self.directory / 'production-compose.private.json'
        private_json(path, compose_spec(self.plan, self.image_id, self.revision))
        self.copy(path, path)
        return path

    def prepare_engine(self):
        """Match the source's config-digest image store before importing receipts.

        Only a gated, otherwise empty destination is eligible. Never rewrite a
        build receipt to accommodate containerd manifest IDs.
        """
        require_active_host(self.root)
        validate_candidate(self.root, self.image, self.source)
        if self.remote('hostname') != self.plan['targetHost']:
            raise RuntimeError('Target hostname mismatch')
        proxy = self.plan['targetProxyContainer']
        present = self.remote('docker', 'ps', '-a', '--format', '{{.Names}}').splitlines()
        if set(present) != {proxy}:
            raise RuntimeError('Engine preparation requires only the gated proxy on the target')
        self.remote('test', '-f', self.plan['targetGate'])
        if 'io.containerd.snapshotter.v1' not in self.remote('docker', 'info', '--format', '{{json .DriverStatus}}'):
            print('Destination already uses the classic image store.')
            return 0
        code = r'''
import json,os,pathlib,subprocess,sys
directory,proxy=sys.argv[1:]
d=pathlib.Path(directory)
def run(*args): return subprocess.check_output(args,text=True).strip()
c=json.loads(run('docker','inspect',proxy))[0]
compose=c['Config']['Labels']['com.docker.compose.project.config_files']
working=c['Config']['Labels']['com.docker.compose.project.working_dir']
image=c['Config']['Image']
config=pathlib.Path('/etc/docker/daemon.json')
original=config.read_text()
backup=d/'docker-daemon.before.json'
if backup.exists(): raise RuntimeError('Engine backup already exists; inspect the previous attempt')
backup.write_text(original);backup.chmod(0o600)
run('docker','image','save','-o',str(d/'proxy-image.tar'),image)
run('docker','update','--restart=no',proxy)
run('docker','stop','--timeout','-1',proxy)
settings=json.loads(original);settings.setdefault('features',{})['containerd-snapshotter']=False
config.write_text(json.dumps(settings,indent=2)+'\n')
run('systemctl','restart','docker')
run('docker','image','load','-i',str(d/'proxy-image.tar'))
run('docker','compose','--project-directory',working,'-f',compose,'up','-d','--no-build','--pull','never')
run('docker','exec',proxy,'nginx','-t')
print(run('docker','info','--format','{{.Driver}} {{json .DriverStatus}}'))
'''
        print(self.remote('python3', '-c', code, str(self.directory), proxy), flush=True)
        return 0

    def remote_health(self):
        code = "import json,urllib.request;print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:3215/ready',timeout=5))))"
        return json.loads(self.remote('python3', '-c', code))

    def stage(self):
        self.validate()
        self.save_compose()
        stage = self.directory / 'stage-data'
        stage.mkdir(exist_ok=True, mode=0o700)
        proof = snapshot_database(self.args.database, stage / 'control-plane.sqlite')
        for name in ['writing-ai.key', 'ssh-access.key', 'video-storage.json']:
            src = Path(self.args.database).parent / name
            if src.exists():
                import shutil
                shutil.copy2(src, stage / name)
        self.remote('mkdir', '-p', str(stage))
        self.copy(str(stage) + '/', str(stage) + '/')
        # Copy backup permissions to the service user without exposing its data.
        user = self.image['Config'].get('User') or '0'
        env = dict(entry.split('=', 1) for entry in self.source['Config']['Env'])
        env['AGENTFLEET_BUILD_SHA'] = self.revision
        env_path = self.directory / 'stage.private.env'
        fd = os.open(env_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(key + '=' + value for key, value in env.items()) + '\n')
        self.copy(env_path, env_path)
        name = 'agentfleet-migration-probe'
        # No ports and no network: the copied production state cannot dispatch work.
        self.remote('docker', 'run', '--rm', '--network', 'none', '--user', '0',
                    '--mount', 'type=bind,source=' + str(stage) + ',target=/probe',
                    '--entrypoint', 'sh', self.image_id, '-c', 'chown -R ' + shlex.quote(user) + ' /probe')
        self.remote('docker', 'run', '-d', '--name', name, '--network', 'none', '--read-only',
                    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--env-file', str(env_path),
                    '--mount', 'type=bind,source=' + str(stage) + ',target=/app/data',
                    '--mount', 'type=volume,source=agentfleet-runtime-releases,target=/app/runtime-releases,readonly', self.image_id)
        try:
            deadline = time.monotonic() + 60
            while True:
                try:
                    ready = json.loads(self.remote('docker', 'exec', name, 'node', '-e',
                        "fetch('http://127.0.0.1:3000/ready').then(r=>r.text()).then(console.log)"))
                    if ready.get('status') == 'ok' and ready.get('build') == self.revision:
                        break
                except (subprocess.CalledProcessError, ValueError):
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError('Isolated probe failed readiness')
                time.sleep(2)
            self.remote('docker', 'exec', name, 'node', '-e',
                "Promise.all([fetch('http://127.0.0.1:3000/').then(r=>{if(r.status!==200)throw Error('web')}),fetch('http://127.0.0.1:3000/downloads/manifest.json').then(r=>{if(r.status!==200)throw Error('manifest')})]).catch(e=>{console.error(e.message);process.exit(1)})")
        finally:
            self.remote('docker', 'stop', '--timeout', '-1', name)
            self.remote('docker', 'rm', name)
        self.record('rehearsed', revision=self.revision, snapshot=proof,
                    planHash=sha256(self.args.migration_config), composeHash=sha256(self.directory / 'production-compose.private.json'))

    def graceful_stop(self, remote=False):
        run = self.remote if remote else lambda *args: execute(list(args))
        run('docker', 'update', '--restart=no', *self.names)
        # SIGTERM only. Never let a timeout escalate into SIGKILL.
        run('docker', 'kill', '--signal=SIGTERM', *self.names)
        deadline = time.monotonic() + 90
        while True:
            containers = json.loads(run('docker', 'inspect', *self.names))
            if all(not c['State']['Running'] for c in containers):
                return
            if time.monotonic() > deadline:
                raise RuntimeError('Graceful shutdown has not completed; fence retained, no forced termination')
            time.sleep(1)

    def install_proxy(self, bridge):
        import shutil
        for item in self.plan['sourceProxyFiles']:
            backup = self.directory / (Path(item['path']).name + '.before')
            path = Path(item['path'])
            if not backup.exists():
                shutil.copy2(path, backup)
            if bridge:
                shutil.copy2(item['bridge'], path)
            else:
                shutil.copy2(backup, path)
        execute(['docker', 'exec', self.plan['sourceProxyContainer'], 'nginx', '-t'])
        execute(['docker', 'exec', self.plan['sourceProxyContainer'], 'nginx', '-s', 'reload'])

    def cutover(self):
        self.validate()
        if self.state.get('phase') != 'rehearsed' or self.state.get('image') != self.image_id:
            raise RuntimeError('This exact image must pass isolated rehearsal first')
        if self.state.get('planHash') != sha256(self.args.migration_config):
            raise RuntimeError('Inventory changed since rehearsal')
        compose = self.directory / 'production-compose.private.json'
        if self.state.get('composeHash') != sha256(compose):
            raise RuntimeError('Compose changed since rehearsal')
        state_path = '/var/lib/docker/volumes/agentfleet-runtime-releases/_data/state.json'
        if json.loads(Path(state_path).read_text()).get('phase') in ('checking', 'downloading', 'validating'):
            raise RuntimeError('Runtime validation is busy; retry later')
        token = uuid.uuid4().hex
        with contextlib.closing(sqlite3.connect(Path(self.args.database).as_uri() + '?mode=rw', uri=True)) as db:
            self.publisher.acquire(db, self.image_id, token)
            if not self.publisher.wait_idle(db, token, self.args.wait_seconds):
                self.publisher.release(db, token)
                return 75
            try:
                self.validate()
                self.record('drained', token=token, revision=self.revision)
            except BaseException:
                self.publisher.release(db, token)
                raise
        self.graceful_stop()
        self.record('source_stopped')
        owner = {'activeHost': self.plan['targetHost'], 'previousHost': self.plan['sourceHost'],
                 'image': self.image_id, 'source': self.revision}
        private_json(registry(self.root) / 'host-owner.json', owner)
        self.copy(registry(self.root) / 'host-owner.json', Path(self.plan['targetRoot']) / '.git/agentfleet-releases/host-owner.json')
        snapshots = {}
        for item in self.plan['databases']:
            destination = self.directory / 'final' / Path(item['source']).name
            snapshots[item['target']] = snapshot_database(item['source'], destination)
            self.copy(destination, item['target'])
            # A newly restored main file must never inherit an unrelated old WAL.
            self.remote('python3', '-c', "from pathlib import Path;import sys;[(Path(sys.argv[1]+s).unlink(missing_ok=True)) for s in ('-wal','-shm')]", item['target'])
            ownership = Path(item['source']).stat()
            self.remote('chown', str(ownership.st_uid) + ':' + str(ownership.st_gid), item['target'])
        for item in self.plan['syncDirectories']:
            self.copy(item['source'].rstrip('/') + '/', item['target'].rstrip('/') + '/', *item.get('options', []))
        for path, proof in snapshots.items():
            actual = self.remote('sha256sum', path).split()[0]
            if actual != proof['sha256']:
                raise RuntimeError('Destination database checksum mismatch')
            self.remote('python3', '-c', "import sqlite3,sys;d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);assert d.execute('pragma quick_check').fetchall()==[('ok',)]", path)
        self.record('data_verified', databases=snapshots)
        self.remote('docker', 'tag', self.image_id, 'agentfleet:local')
        self.remote('docker', 'compose', '--project-directory', self.plan['targetRoot'],
                    '-f', str(compose), 'up', '-d', '--no-build')
        self.record('target_started_gated')
        deadline = time.monotonic() + 120
        while True:
            try:
                ready = self.remote_health()
                services = json.loads(self.remote('docker', 'inspect', *self.names))
                healthy = all(c['State']['Running'] and c['State'].get('Health', {}).get('Status', 'healthy') == 'healthy' for c in services)
                if healthy and ready.get('status') == 'ok' and ready.get('build') == self.revision and ready.get('voiceDeploymentGuard') == 1:
                    break
            except (subprocess.CalledProcessError, ValueError):
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('Target readiness failed; both admission fences retained')
            time.sleep(2)
        # Irreversible boundary for the simple abort: set journal first, then admit traffic.
        self.record('admitting_target')
        self.remote('rm', '--', self.plan['targetGate'])
        self.install_proxy(True)
        self.remote('python3', '-c', "import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute('delete from voice_deployment_guard where token=?',(sys.argv[2],));d.commit()", self.args.database, token)
        self.record('traffic_on_target')
        # The source DB remains fenced and source containers have restart disabled.
        expected = self.remote('docker', 'exec', 'agentfleet-control-plane', 'node', '-e',
                              "console.log(require('/app/web/downloads/manifest.json').version)")
        execute(['node', str(self.root / 'packaging/verify-published-installers.mjs'),
                 self.plan['publicOrigin'], expected])
        self.record('published', agentVersion=expected)
        return 0

    def abort(self):
        if self.state.get('phase') not in ('drained', 'source_stopped', 'data_verified', 'target_started_gated'):
            raise RuntimeError('Abort is allowed only before traffic admission; newer writes require reverse migration')
        self.remote('test', '-f', self.plan['targetGate'])
        present = set(self.remote('docker', 'ps', '-a', '--format', '{{.Names}}').splitlines())
        if present.intersection(self.names):
            if not set(self.names).issubset(present):
                raise RuntimeError('Partial target startup needs manual inspection')
            self.graceful_stop(remote=True)
        for c in self.plan['containers']:
            execute(['docker', 'update', '--restart=' + (c['HostConfig']['RestartPolicy']['Name'] or 'no'), c['Name']])
        execute(['docker', 'start', *self.names])
        self.install_proxy(False)
        deadline = time.monotonic() + 90
        while True:
            try:
                if self.publisher.health(self.args.ready_url).get('status') == 'ok':
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('Source is not ready; fence retained')
            time.sleep(2)
        with contextlib.closing(sqlite3.connect(self.args.database)) as db:
            self.publisher.release(db, self.state['token'])
        private_json(registry(self.root) / 'host-owner.json', {'activeHost': self.plan['sourceHost']})
        self.record('aborted_before_traffic')
        return 0


def run_migration(root, args, publisher):
    migration = Migration(root, args, publisher)
    # Also prevents target publishers during the handoff. SSH owns the remote lock
    # until stdin closes; durable guards and the journal survive a lost coordinator.
    with open(args.database + '.publish.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        remote_code = "import fcntl,sys;f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('locked',flush=True);sys.stdin.read()"
        remote_lock = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', migration.target,
            shlex.join(['python3', '-u', '-c', remote_code, args.database + '.publish.lock'])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            if remote_lock.stdout.readline().strip() != 'locked':
                raise RuntimeError('Could not acquire target publication lock')
            migration.target_lock = remote_lock
            if args.migration_phase == 'prepare-engine':
                return migration.prepare_engine()
            if args.migration_phase == 'preflight':
                migration.validate()
                migration.save_compose()
                print(json.dumps({'migrationPhase': 'preflight_passed', 'image': migration.image_id}))
                return 0
            if args.migration_phase == 'rehearse':
                migration.stage()
                return 0
            if args.migration_phase == 'abort-before-traffic':
                return migration.abort()
            return migration.cutover()
        finally:
            remote_lock.stdin.close()
            remote_lock.wait(timeout=15)
