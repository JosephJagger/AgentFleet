#!/usr/bin/env python3
"""Build a panel release from a clean main commit, never from a working directory overlay."""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import uuid

from deployment_provenance import (BASE_LABEL, MODE_LABEL, POLICY_VERSION, SOURCE_LABEL, git,
    read_receipt, require_ancestor, require_clean_main, require_mode_covers_changes, write_receipt, require_active_host)

ROOT = Path(__file__).resolve().parents[1]


def prepare(root, mode, with_identity=False):
    require_active_host(root)
    sha = require_clean_main(root)
    live = json.loads(subprocess.check_output(['docker', 'inspect', 'agentfleet-control-plane']))[0]
    base_id = live['Image']
    baseline = read_receipt(root, base_id)
    require_ancestor(root, baseline['source'], sha)
    if with_identity and mode == 'web':
        raise RuntimeError('Paired identity builds require control-plane or full mode')
    identity_live = json.loads(subprocess.check_output(['docker', 'inspect', 'agentfleets-identity-1']))[0] if with_identity else None
    require_mode_covers_changes(root, baseline['source'], sha, mode, with_identity=with_identity)
    suffix = uuid.uuid4().hex
    base_tag = 'agentfleet:build-base-' + suffix
    target = 'agentfleet:prepared-' + sha[:12] + '-' + suffix[:8]
    # A unique local tag pins FROM to the inspected image, not a mutable :local tag.
    subprocess.run(['docker', 'tag', base_id, base_tag], check=True)
    try:
        with tempfile.TemporaryDirectory(prefix='agentfleet-release-') as directory:
            archive = subprocess.check_output(['git', '-C', str(root), 'archive', '--format=tar', sha])
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                source.extractall(directory, filter='data')
            dockerfile = {'web': 'packaging/Dockerfile.web', 'control-plane': 'packaging/Dockerfile.control-plane', 'full': 'Dockerfile'}[mode]
            subprocess.run(['docker', 'build', '-f', str(Path(directory) / dockerfile),
                '--build-arg', 'BASE_IMAGE=' + base_tag, '--build-arg', 'AGENTFLEET_BUILD_SHA=' + sha,
                '--label', SOURCE_LABEL + '=' + sha, '--label', BASE_LABEL + '=' + base_id,
                '--label', MODE_LABEL + '=' + mode, '-t', target, directory], check=True)
            if with_identity:
                identity_tag = target + '-identity'
                subprocess.run(['docker', 'build', '-f', str(Path(directory) / 'apps/identity/Dockerfile'),
                    '--build-arg', 'AGENTFLEET_BUILD_SHA=' + sha,
                    '--label', SOURCE_LABEL + '=' + sha, '--label', BASE_LABEL + '=' + identity_live['Image'],
                    '--label', MODE_LABEL + '=identity', '-t', identity_tag, directory], check=True)
        # A concurrent commit or dirty edit invalidates this attempt; no receipt is issued.
        require_clean_main(root, sha)
        current = json.loads(subprocess.check_output(['docker', 'inspect', 'agentfleet-control-plane']))[0]
        if current['Image'] != base_id:
            raise RuntimeError('Live image changed during build; rebuild before publication')
        image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', target]))[0]
        record = {'policyVersion': POLICY_VERSION, 'kind': 'prepared', 'source': sha,
                  'tree': git(root, 'rev-parse', sha + '^{tree}'), 'image': image['Id'],
                  'baseImage': base_id, 'mode': mode}
        if with_identity:
            current_identity = json.loads(subprocess.check_output(['docker', 'inspect', 'agentfleets-identity-1']))[0]
            if current_identity['Image'] != identity_live['Image']:
                raise RuntimeError('Live identity changed during build; rebuild both images')
            identity = json.loads(subprocess.check_output(['docker', 'image', 'inspect', identity_tag]))[0]
            write_receipt(root, {'policyVersion': POLICY_VERSION, 'kind': 'prepared-identity', 'source': sha,
                'tree': record['tree'], 'image': identity['Id'], 'baseImage': identity_live['Image'], 'mode': 'identity'})
            record.update(identityImage=identity['Id'], baseIdentityImage=identity_live['Image'])
        write_receipt(root, record)
        print(json.dumps({'phase': 'prepared', 'tag': target, **record}), flush=True)
        return record
    finally:
        subprocess.run(['docker', 'image', 'rm', base_tag], stdout=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['web', 'control-plane', 'full'], required=True)
    parser.add_argument('--with-identity', action='store_true', help='Build both services from the same commit for coordinated publication')
    args = parser.parse_args()
    prepare(ROOT, args.mode, args.with_identity)
