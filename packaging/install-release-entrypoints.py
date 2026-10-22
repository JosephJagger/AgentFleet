#!/usr/bin/env python3
"""Route registered legacy worktrees through the canonical main deployment scripts."""
import json
from pathlib import Path
import subprocess
from deployment_provenance import git, registry, require_clean_main

ROOT = Path(__file__).resolve().parents[1]
MARKER = '# Managed AgentFleets release forwarder v1'
NOTE = '''# Deployment from this legacy worktree

This worktree shares the production deployment with other Agents. Do not deploy directly or run Docker/Compose to publish. Commit and integrate into main first. Use the canonical main worktree's `packaging/prepare-panel-release.py` and `packaging/deploy-control-plane.py`. The local packaging forwarding files route to main; do not commit or remove them. Read main's AGENTS.md and docs/release-provenance.md. Never publish an uncommitted overlay or overwrite a newer live release.
'''


def install(root):
    require_clean_main(root)
    problems = []
    for block in git(root, 'worktree', 'list', '--porcelain').split('\n\n'):
        if not block:
            continue
        worktree = Path(block.splitlines()[0].removeprefix('worktree '))
        if not worktree.exists() or worktree.resolve() == Path(root).resolve():
            continue
        for name in ['deploy-control-plane.py', 'prepare-panel-release.py']:
            relative = 'packaging/' + name
            path = worktree / relative
            old = path.read_text() if path.exists() else ''
            if old and MARKER not in old:
                tracked = subprocess.run(['git', '-C', str(worktree), 'show', 'HEAD:' + relative], capture_output=True, text=True)
                if tracked.returncode or tracked.stdout != old:
                    problems.append(str(path) + ': locally modified; not overwritten')
                    continue
                backup = registry(root) / 'legacy-entrypoints' / worktree.name / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                if not backup.exists():
                    backup.write_text(old)
            path.parent.mkdir(parents=True, exist_ok=True)
            target = str(Path(root) / relative)
            path.write_text('#!/usr/bin/env python3\n' + MARKER + '\nimport os, sys\nos.execv(sys.executable, [sys.executable, ' + repr(target) + ', *sys.argv[1:]])\n')
        note = worktree / 'AGENTS.md'
        if not note.exists():
            note.write_text(NOTE)
        elif note.read_text() != NOTE and 'Shared development and publication rules' not in note.read_text():
            problems.append(str(note) + ': existing instructions retained; add canonical deployment rule manually')
    print(json.dumps({'phase': 'entrypoints-installed', 'problems': problems}))
    if problems:
        raise RuntimeError('Some worktrees require manual entrypoint reconciliation; see problems above')


if __name__ == '__main__':
    install(ROOT)
