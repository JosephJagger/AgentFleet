import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deployment_provenance as p


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load('prepare', 'prepare-panel-release.py')
adoption = load('adoption', 'adopt-live-release.py')
installer = load('installer', 'install-release-entrypoints.py')
BASE = 'sha256:' + 'a' * 64
NEXT = 'sha256:' + 'b' * 64
OTHER = 'sha256:' + 'c' * 64


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        self.g('init', '-b', 'main')
        self.g('config', 'user.email', 'test@example.test')
        self.g('config', 'user.name', 'Test')
        self.commit('apps/web/app.txt', 'initial')
        self.first = self.g('rev-parse', 'HEAD')
        self.baseline = {'policyVersion': 1, 'kind': 'reconciled-baseline', 'image': BASE, 'source': self.first}
        p.write_receipt(self.root, self.baseline)
        self.commit('apps/web/app.txt', 'next')
        self.sha = self.g('rev-parse', 'HEAD')
        self.record = {'policyVersion': 1, 'kind': 'prepared', 'image': NEXT, 'source': self.sha, 'baseImage': BASE, 'mode': 'web'}
        p.write_receipt(self.root, self.record)
        self.image = {'Id': NEXT, 'Config': {'Env': ['AGENTFLEET_BUILD_SHA=' + self.sha], 'Labels': {
            p.SOURCE_LABEL: self.sha, p.BASE_LABEL: BASE, p.MODE_LABEL: 'web'}}}
        self.runtime = {'Image': BASE}

    def g(self, *args):
        return p.git(self.root, *args)

    def commit(self, path, value):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value)
        self.g('add', path)
        self.g('commit', '-m', 'fixture', '--quiet')

    def test_clean_main_descendant_and_exact_base_are_accepted(self):
        self.assertEqual(p.validate_candidate(self.root, self.image, self.runtime), self.record)

    def test_dirty_tracked_and_untracked_files_are_rejected(self):
        for name in ['apps/web/app.txt', 'new-untracked.txt']:
            with self.subTest(name=name):
                file = self.root / name
                previous = file.read_text() if file.exists() else None
                file.write_text('uncommitted')
                with self.assertRaisesRegex(RuntimeError, 'uncommitted'):
                    p.validate_candidate(self.root, self.image, self.runtime)
                if previous is None:
                    file.unlink()
                else:
                    file.write_text(previous)

    def test_feature_worktrees_share_receipts_but_cannot_publish(self):
        child = Path(self.tmp.name) / 'task'
        self.g('worktree', 'add', '-b', 'task', str(child))
        self.assertEqual(p.registry(child), p.registry(self.root))
        with self.assertRaisesRegex(RuntimeError, 'merge your task branch'):
            p.validate_candidate(child, self.image, self.runtime)

    def test_forged_labels_without_receipt_are_rejected(self):
        self.image['Id'] = OTHER
        with self.assertRaisesRegex(RuntimeError, 'no verified build receipt'):
            p.validate_candidate(self.root, self.image, self.runtime)

    def test_short_or_fabricated_build_version_cannot_match_receipt(self):
        self.image['Config']['Env'] = ['AGENTFLEET_BUILD_SHA=' + self.sha[:7] + '-manual']
        with self.assertRaisesRegex(RuntimeError, 'metadata'):
            p.validate_candidate(self.root, self.image, self.runtime)

    def test_main_advancing_after_build_requires_rebuild(self):
        self.commit('apps/web/another.txt', 'later task')
        with self.assertRaisesRegex(RuntimeError, 'main changed'):
            p.validate_candidate(self.root, self.image, self.runtime)

    def test_live_image_changes_even_at_same_commit_require_rebuild(self):
        p.write_receipt(self.root, {**self.baseline, 'image': OTHER})
        with self.assertRaisesRegex(RuntimeError, 'Live image changed'):
            p.validate_candidate(self.root, self.image, {'Image': OTHER})

    def test_unregistered_live_image_blocks_release(self):
        with self.assertRaisesRegex(RuntimeError, 'no verified build receipt'):
            p.validate_candidate(self.root, self.image, {'Image': OTHER})

    def test_divergent_live_commit_is_rejected(self):
        child = Path(self.tmp.name) / 'parallel'
        self.g('worktree', 'add', '-b', 'parallel', str(child), self.first)
        (child / 'parallel.txt').write_text('live feature')
        p.git(child, 'add', '.')
        p.git(child, 'commit', '-m', 'parallel', '--quiet')
        live_sha = p.git(child, 'rev-parse', 'HEAD')
        p.write_receipt(self.root, {**self.baseline, 'image': OTHER, 'source': live_sha})
        with self.assertRaisesRegex(RuntimeError, 'does not contain'):
            p.validate_candidate(self.root, self.image, {'Image': OTHER})

    def test_web_build_cannot_silently_retain_changed_backend(self):
        self.commit('apps/control-plane/server.txt', 'changed backend')
        current = self.g('rev-parse', 'HEAD')
        with self.assertRaisesRegex(RuntimeError, 'retain changed components'):
            p.require_mode_covers_changes(self.root, self.first, current, 'web')
        p.require_mode_covers_changes(self.root, self.first, current, 'control-plane')
        self.commit('apps/local-agent/agent.txt', 'new agent')
        with self.assertRaisesRegex(RuntimeError, 'retain changed components'):
            p.require_mode_covers_changes(self.root, self.first, self.g('rev-parse', 'HEAD'), 'control-plane')

    def test_identity_changes_require_a_paired_build_and_both_verified_images(self):
        self.commit('apps/identity/app.py','new identity')
        sha=self.g('rev-parse','HEAD');identity_id='sha256:'+'d'*64;identity_base='sha256:'+'e'*64
        with self.assertRaisesRegex(RuntimeError,'retain changed components'):
            p.require_mode_covers_changes(self.root,self.first,sha,'control-plane')
        record={**self.record,'image':OTHER,'source':sha,'mode':'control-plane','identityImage':identity_id,'baseIdentityImage':identity_base}
        p.write_receipt(self.root,record)
        p.write_receipt(self.root,{'policyVersion':1,'kind':'prepared-identity','image':identity_id,'source':sha,'baseImage':identity_base,'mode':'identity'})
        image={'Id':OTHER,'Config':{'Env':['AGENTFLEET_BUILD_SHA='+sha],'Labels':{p.SOURCE_LABEL:sha,p.BASE_LABEL:BASE,p.MODE_LABEL:'control-plane'}}}
        identity={'Id':identity_id,'Config':{'Env':['AGENTFLEET_BUILD_SHA='+sha],'Labels':{p.SOURCE_LABEL:sha,p.BASE_LABEL:identity_base,p.MODE_LABEL:'identity'}}}
        with self.assertRaisesRegex(RuntimeError,'coordinated'):
            p.validate_candidate(self.root,image,self.runtime)
        self.assertEqual(p.validate_candidate(self.root,image,self.runtime,identity_runtime={'Image':identity_base},identity_image=identity),record)
        with self.assertRaisesRegex(RuntimeError,'Identity changed'):
            p.validate_candidate(self.root,image,self.runtime,identity_runtime={'Image':OTHER},identity_image=identity)
        identity['Config']['Labels'][p.SOURCE_LABEL]='f'*40
        with self.assertRaisesRegex(RuntimeError,'Identity image metadata'):
            p.validate_candidate(self.root,image,self.runtime,identity_runtime={'Image':identity_base},identity_image=identity)

    def test_retired_sqlite_cannot_be_reopened_by_old_publication_commands(self):
        path=self.root/'old.sqlite';path.touch()
        (p.registry(self.root)/'database-owner.json').write_text(json.dumps({'engine':'postgresql','retiredSqlite':[str(path)]}))
        with self.assertRaisesRegex(RuntimeError,'retired'): p.require_current_sqlite(self.root,path)
        p.require_current_sqlite(self.root,self.root/'independent.sqlite')

    def test_receipt_is_immutable_and_digest_path_is_validated(self):
        p.write_receipt(self.root, self.record)
        with self.assertRaisesRegex(RuntimeError, 'refusing to overwrite'):
            p.write_receipt(self.root, {**self.record, 'source': self.first})
        with self.assertRaisesRegex(RuntimeError, 'immutable Docker image digest'):
            p.receipt_path(self.root, '../../escape')

    def test_legacy_baseline_cannot_be_published_as_a_prepared_build(self):
        with self.assertRaisesRegex(RuntimeError, 'Only clean prepared releases'):
            p.validate_candidate(self.root, {**self.image, 'Id': BASE}, self.runtime)

    def test_adoption_cannot_be_used_after_baseline_is_established(self):
        evidence = Path(self.tmp.name) / 'evidence.json'
        evidence.write_text(json.dumps({'source': self.sha, 'image': BASE, 'reconciliation': 'reviewed', 'verification': 'checked'}))
        with self.assertRaisesRegex(RuntimeError, 'already established'):
            adoption.adopt(self.root, evidence, BASE)

    def test_legacy_installation_routes_old_worktree_without_touching_app(self):
        child = Path(self.tmp.name) / 'old'
        self.g('worktree', 'add', '-b', 'old', str(child), self.first)
        (child / 'apps/web/app.txt').write_text('another session is editing')
        installer.install(self.root)
        self.assertIn(str(self.root / 'packaging/deploy-control-plane.py'), (child / 'packaging/deploy-control-plane.py').read_text())
        self.assertEqual((child / 'apps/web/app.txt').read_text(), 'another session is editing')
        installer.install(self.root)  # idempotent

    def test_installer_refuses_to_overwrite_local_publisher_changes(self):
        child = Path(self.tmp.name) / 'old'
        self.g('worktree', 'add', '-b', 'old', str(child), self.first)
        script = child / 'packaging/deploy-control-plane.py'
        script.parent.mkdir()
        script.write_text('local work')
        with self.assertRaisesRegex(RuntimeError, 'manual entrypoint reconciliation'):
            installer.install(self.root)
        self.assertEqual(script.read_text(), 'local work')

    def test_one_time_adoption_records_legacy_evidence_without_claiming_a_build(self):
        for path in (p.registry(self.root) / 'images').glob('*.json'):
            path.unlink()
        evidence = Path(self.tmp.name) / 'legacy.json'
        evidence.write_text(json.dumps({'source': self.sha, 'image': BASE, 'reconciliation': ['all live overlays merged'], 'verification': ['bundle matches']}))
        original = subprocess.check_output
        def output(args, **kwargs):
            if args[0] == 'docker':
                return json.dumps([self.runtime]).encode()
            return original(args, **kwargs)
        with patch.object(subprocess, 'check_output', side_effect=output):
            adoption.adopt(self.root, evidence, BASE)
        self.assertEqual(p.read_receipt(self.root, BASE)['kind'], 'reconciled-baseline')
        self.assertTrue((p.registry(self.root) / 'baseline-evidence.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'already established'):
            adoption.adopt(self.root, evidence, BASE)

    def test_failed_build_never_gets_a_receipt(self):
        original_output, original_run = subprocess.check_output, subprocess.run
        def output(args, **kwargs):
            if args[0] == 'docker':
                return json.dumps([self.runtime]).encode()
            return original_output(args, **kwargs)
        def run(args, **kwargs):
            if args[0] != 'docker':
                return original_run(args, **kwargs)
            if args[1] == 'build':
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)
        with patch.object(subprocess, 'check_output', side_effect=output), patch.object(subprocess, 'run', side_effect=run):
            with self.assertRaises(subprocess.CalledProcessError):
                prepare.prepare(self.root, 'web')
        self.assertEqual(len(list((p.registry(self.root) / 'images').glob('*.json'))), 2)

    def test_archive_build_excludes_ignored_files_and_records_digest(self):
        self.commit('.gitignore', 'secret.env\n')
        (self.root / 'secret.env').write_text('must not enter archive')
        current = self.g('rev-parse', 'HEAD')
        original_output, original_run = subprocess.check_output, subprocess.run
        commands = []
        def output(args, **kwargs):
            if args[0] == 'docker':
                return json.dumps([{'Id': OTHER}] if args[1:3] == ['image', 'inspect'] else [self.runtime]).encode()
            return original_output(args, **kwargs)
        def run(args, **kwargs):
            if args[0] != 'docker':
                return original_run(args, **kwargs)
            commands.append(args)
            if args[1] == 'build':
                exported = Path(args[-1])
                self.assertFalse((exported / 'secret.env').exists())
                self.assertFalse((exported / '.git').exists())
                self.assertEqual((exported / 'apps/web/app.txt').read_text(), 'next')
                self.assertIn('AGENTFLEET_BUILD_SHA=' + current, args)
            return subprocess.CompletedProcess(args, 0)
        with patch.object(subprocess, 'check_output', side_effect=output), patch.object(subprocess, 'run', side_effect=run):
            record = prepare.prepare(self.root, 'web')
        self.assertEqual(record['source'], current)
        self.assertEqual(p.read_receipt(self.root, OTHER), record)
        self.assertTrue(any(c[:3] == ['docker', 'image', 'rm'] for c in commands))


if __name__ == '__main__':
    unittest.main()
