"""Exercise the actual POSIX fresh-install guards only, in disposable paths."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

PACKAGING = Path(__file__).resolve().parent


@unittest.skipIf(os.name == "nt", "PowerShell guard has a separate Windows test")
class FreshInstallGuard(unittest.TestCase):
    def check_guard(self, script_name):
        text = (PACKAGING / script_name).read_text()
        start = text.index('if [ "${AGENTFLEET_NPM_FRESH_INSTALL:-}" = 1 ]; then')
        end = text.index('\nfi\n', start) + 4
        # This is deliberately a post-lock check, not only a CLI preflight.
        self.assertGreater(start, text.rindex('\nacquire_install_lock\n', 0, start))
        self.assertLess(end, text.index('\natomic_link "$CURRENT_LINK"', end))
        guard = text[start:end]
        with tempfile.TemporaryDirectory(prefix="npm-fresh-test-") as temporary:
            root = Path(temporary)
            data = root / 'data'
            data.mkdir()
            current = root / 'launcher'
            previous = root / 'previous'
            state_dir = data / 'agentfleet' if script_name == 'install.sh' else data
            state_dir.mkdir(exist_ok=True)
            profile = state_dir / 'runtime-profile.json'
            env = {**os.environ, 'AGENTFLEET_NPM_FRESH_INSTALL': '1',
                   'HOME': str(root), 'INSTALL_UID': '1000', 'XDG_CONFIG_HOME': str(root / '.config'),
                   'CURRENT_LINK': str(current), 'PREVIOUS_LINK': str(previous),
                   'DATA_ROOT': str(data), 'SERVICE_DATA_DIR': '', 'RUNTIME_PROFILE': str(profile)}
            def run(environment=env):
                return subprocess.run(['sh', '-c', guard], env=environment, capture_output=True)
            self.assertEqual(run().returncode, 0)
            (state_dir / 'download-cache').mkdir()
            self.assertEqual(run().returncode, 0, 'Cache alone must not block fresh installation')
            for path in [current, previous, state_dir / 'state.sqlite', profile]:
                with self.subTest(script=script_name, existing=path.name):
                    path.write_text('preserve this synthetic fixture')
                    self.assertEqual(run().returncode, 23)
                    self.assertEqual(run({**env, 'AGENTFLEET_NPM_FRESH_INSTALL': ''}).returncode, 0)
                    self.assertEqual(path.read_text(), 'preserve this synthetic fixture')
                    path.unlink()
            current.symlink_to(root / 'missing-version')
            self.assertEqual(run().returncode, 23, 'Dangling pointers must not permit replacement')
            self.assertTrue(current.is_symlink())
            current.unlink()
            service = root / ('.config/systemd/user/agentfleet.service' if script_name == 'install.sh' else 'Library/LaunchAgents/cn.agentfleets.agent.plist')
            service.parent.mkdir(parents=True)
            service.write_text('synthetic service')
            self.assertEqual(run().returncode, 23)

    def test_linux(self):
        self.check_guard('install.sh')

    def test_macos(self):
        self.check_guard('install-macos.sh')


if __name__ == '__main__':
    unittest.main()
