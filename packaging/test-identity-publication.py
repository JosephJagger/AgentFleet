import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import identity_publication as module
from identity_publication import IdentityPublication, validate_identity_scope


def runtime(image='old'):
    return {'Image': image, 'Config': {'Env': ['AGENTFLEET_BUILD_SHA=oldsha', 'DJANGO_DATABASE_URL=postgresql://db/identity']}}

class IdentityTests(unittest.TestCase):
    def test_scope_rejects_schema_and_unproven_sources(self):
        with patch.object(module, 'require_ancestor'), patch.object(module, 'git', return_value='apps/identity/accounts/models.py'):
            with self.assertRaisesRegex(RuntimeError, 'email-template'):
                validate_identity_scope('.', runtime(), 'new')
        with self.assertRaisesRegex(RuntimeError, 'provenance'):
            validate_identity_scope('.', {'Config': {'Env': []}}, 'new')

    def test_scope_accepts_only_templates_on_postgres(self):
        with patch.object(module, 'require_ancestor'), patch.object(module, 'git', return_value='apps/identity/accounts/email.py\napps/identity/accounts/tests.py'):
            validate_identity_scope('.', runtime(), 'new')
            other = runtime(); other['Config']['Env'] = ['AGENTFLEET_BUILD_SHA=oldsha']
            with self.assertRaisesRegex(RuntimeError, 'PostgreSQL'):
                validate_identity_scope('.', other, 'new')

    def test_recheck_rejects_environment_changes_before_validating(self):
        with tempfile.TemporaryDirectory() as directory:
            obj = IdentityPublication.__new__(IdentityPublication)
            obj.env_path = Path(directory) / '.env'; obj.env_path.write_bytes(b'changed')
            obj.original_env = b'original'; obj.run = lambda *args: json.dumps([runtime()])
            with self.assertRaisesRegex(RuntimeError, 'environment changed'):
                obj.recheck({}, {})

    def test_ready_requires_digest_database_build_and_health(self):
        obj = IdentityPublication.__new__(IdentityPublication)
        obj.image_id = 'new'; obj.runtime = runtime()
        for image, build, backend, status, expected in [('new','sha','postgresql','ok',True),('old','sha','postgresql','ok',False),('new','other','postgresql','ok',False),('new','sha','sqlite','ok',False),('new','sha','postgresql','error',False)]:
            obj.run = lambda *args: json.dumps([runtime(image)]) if args[1]=='inspect' else json.dumps({'status':status,'build':build,'databaseBackend':backend})
            self.assertEqual(obj.ready('sha'), expected)

    def test_backup_failure_never_activates_compose(self):
        with tempfile.TemporaryDirectory() as directory:
            obj = IdentityPublication.__new__(IdentityPublication);obj.runtime=runtime()
            db = type('DB', (), {'config':{'dumpContainer':'pg'},'path':Path(directory)/'control'})()
            with patch.object(module.PostgresPublication, 'backup', side_effect=RuntimeError('dump failed')):
                with self.assertRaisesRegex(RuntimeError, 'dump failed'): obj.prepare(db,'abc')
            self.assertFalse(hasattr(obj, 'override'))

if __name__ == '__main__': unittest.main()
