# Shared development and publication rules

Independent worktrees isolate source files, not deployment, databases, Docker tags or services.

- Develop and test on a task branch. Commit the intended files and merge the latest `main` before integration. Do not include another session's uncommitted changes.
- Production releases are built **only from clean, committed `main`**, using `packaging/prepare-panel-release.py`. Never build a release from a dirty worktree, a copied overlay, or a manually chosen build-version string.
- Find the canonical main worktree with `git worktree list`. All worktrees use its `packaging/deploy-control-plane.py`; do not use a historical copy, raw `docker compose up`, `restart`, or manual retagging to publish.
- The publisher requires a shared build receipt, full commit SHA, current live base image, and inclusion of the live commit. A stale candidate must be rebuilt after integrating newer changes; never bypass the check or relabel an old image.
- Publication waits for both voice calls and SSH relay streams. Never terminate them or force browser reloads to publish.
- Report separately: committed, merged, prepared, and published. “Tests passed” does not mean “online.”
- If a legacy/unregistered image is live, stop normal publication and reconcile its actual source. The one-time baseline adoption requires an evidence file; it is not a workaround for a failed release check.

See `docs/release-provenance.md` for commands, recovery and the Docker/root privilege boundary.
