"""Local release provenance shared by all Git worktrees; not a Docker/root security boundary."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile

POLICY_VERSION = 1
SOURCE_LABEL = 'io.agentfleet.source-revision'
BASE_LABEL = 'io.agentfleet.base-image'
MODE_LABEL = 'io.agentfleet.build-mode'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def release_root(root):
    for block in git(root, 'worktree', 'list', '--porcelain').split('\n\n'):
        lines = block.splitlines()
        if 'branch refs/heads/main' in lines:
            return Path(lines[0].removeprefix('worktree ')).resolve()
    raise RuntimeError('main must be checked out in the canonical release worktree')


def require_clean_main(root, expected=None):
    root = Path(root).resolve()
    canonical = release_root(root)
    if root != canonical or git(root, 'symbolic-ref', '--short', 'HEAD') != 'main':
        raise RuntimeError(f'Releases must run from main at {canonical}; merge your task branch first')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        raise RuntimeError('Release worktree has uncommitted or untracked files; commit and merge before building/publishing')
    sha = git(root, 'rev-parse', 'HEAD')
    if expected and sha != expected:
        raise RuntimeError('main changed after preparation; rebuild the latest main before publishing')
    return sha


def require_active_host(root):
    """A handed-off source must not publish or reopen its old database."""
    path = registry(root) / 'host-owner.json'
    if path.exists():
        owner = json.loads(path.read_text())
        if owner.get('activeHost') != socket.gethostname():
            raise RuntimeError('This host has handed production to ' + str(owner.get('activeHost')))


def registry(root):
    common = Path(git(root, 'rev-parse', '--git-common-dir'))
    if not common.is_absolute():
        common = Path(root) / common
    return common.resolve() / 'agentfleet-releases'


def receipt_path(root, image_id):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise RuntimeError('Expected an immutable Docker image digest')
    return registry(root) / 'images' / (image_id[7:] + '.json')


def write_receipt(root, record):
    path = receipt_path(root, record['image'])
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Identical records are idempotent; never rewrite an image's established provenance.
    data = json.dumps(record, sort_keys=True, indent=2) + '\n'
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        stream.write(data)
    try:
        try:
            os.link(temp, path)
        except FileExistsError:
            if json.loads(path.read_text()) != record:
                raise RuntimeError('Image already has different provenance; refusing to overwrite it')
    finally:
        temp.unlink()


def read_receipt(root, image_id):
    path = receipt_path(root, image_id)
    if not path.exists():
        raise RuntimeError('Image has no verified build receipt; use prepare-panel-release.py (legacy live images need one-time reconciliation)')
    record = json.loads(path.read_text())
    if record.get('image') != image_id or record.get('policyVersion') != POLICY_VERSION:
        raise RuntimeError('Invalid release receipt')
    sha = record.get('source', '')
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or git(root, 'rev-parse', sha + '^{commit}') != sha:
        raise RuntimeError('Receipt must name an existing full source commit')
    return record


def require_ancestor(root, previous, candidate):
    result = subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', previous, candidate], capture_output=True)
    if result.returncode:
        raise RuntimeError('Candidate does not contain the live source commit; merge the live changes before rebuilding')


def require_mode_covers_changes(root, previous, candidate, mode):
    if mode not in ('web', 'control-plane', 'full'):
        raise RuntimeError('Unsupported build mode')
    paths = git(root, 'diff', '--name-only', previous, candidate).splitlines()
    # Files outside these inputs are docs/tests/tools, not retained application code.
    protected = ['apps/local-agent/', 'packages/', 'Dockerfile', 'packaging/build-', 'packaging/prepare-code-mode.mjs']
    if mode == 'web':
        protected += ['apps/control-plane/', 'packaging/install.sh', 'packaging/install-macos.sh', 'packaging/install.ps1']
    blocked = [p for p in paths if mode != 'full' and any(p.startswith(prefix) for prefix in protected)]
    # This publisher never replaces identity; changing it needs a dedicated coordinated release.
    blocked += [p for p in paths if p.startswith('apps/identity/')]
    if blocked:
        raise RuntimeError(f'{mode} build would retain changed components: ' + ', '.join(blocked[:8]))


def image_build(image):
    return next((v.split('=', 1)[1] for v in image['Config'].get('Env', []) if v.startswith('AGENTFLEET_BUILD_SHA=')), None)


def validate_candidate(root, image, runtime):
    """Call under the publication lock, and again immediately before switching."""
    candidate = read_receipt(root, image['Id'])
    if candidate.get('kind') != 'prepared':
        raise RuntimeError('Only clean prepared releases may be published; baseline adoption is not a build')
    sha = require_clean_main(root, candidate['source'])
    live = read_receipt(root, runtime['Image'])
    require_ancestor(root, live['source'], sha)
    if candidate.get('baseImage') != runtime['Image']:
        raise RuntimeError('Live image changed after preparation; rebuild on the current live image')
    require_mode_covers_changes(root, live['source'], sha, candidate['mode'])
    labels = image['Config'].get('Labels') or {}
    if image_build(image) != sha or labels.get(SOURCE_LABEL) != sha or labels.get(BASE_LABEL) != runtime['Image'] or labels.get(MODE_LABEL) != candidate['mode']:
        raise RuntimeError('Image metadata does not match its verified build receipt')
    return candidate
