#!/usr/bin/env python3
"""One-time reconciliation of a legacy live image after its complete source has been merged into main."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
from deployment_provenance import POLICY_VERSION, registry, require_clean_main, write_receipt

ROOT = Path(__file__).resolve().parents[1]


def adopt(root, evidence_path, expected_image):
    sha = require_clean_main(root)
    evidence = json.loads(Path(evidence_path).read_text())
    if evidence.get('source') != sha or evidence.get('image') != expected_image or not evidence.get('reconciliation') or not evidence.get('verification'):
        raise RuntimeError('Evidence must identify this exact main commit, live image, reconciliation and verification')
    directory = registry(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / 'adoption.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (directory / 'baseline-adoption.json').exists() or list((directory / 'images').glob('*.json')):
            raise RuntimeError('Baseline already established; adoption cannot bypass normal release checks')
        live = json.loads(subprocess.check_output(['docker', 'inspect', 'agentfleet-control-plane']))[0]
        if live['Image'] != expected_image:
            raise RuntimeError('Live image changed; reconcile the new image first')
        record = {'policyVersion': POLICY_VERSION, 'kind': 'reconciled-baseline', 'source': sha,
                  'image': expected_image, 'evidenceSha256': hashlib.sha256(Path(evidence_path).read_bytes()).hexdigest()}
        # Preserve the evidence before the receipt; failure leaves adoption retryable.
        (directory / 'baseline-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        write_receipt(root, record)
        (directory / 'baseline-adoption.json').write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'phase': 'baseline-adopted', **record}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, help='Reviewed local JSON, not an assertion that legacy images were built cleanly')
    parser.add_argument('--expected-image', required=True)
    args = parser.parse_args()
    adopt(ROOT, args.evidence, args.expected_image)
