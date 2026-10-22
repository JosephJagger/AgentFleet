# Release provenance across worktrees

A worktree protects source edits from another worktree. It does not protect a shared production deployment. A web-only Docker build replaces the entire web bundle, even when it inherits the live backend image.

## Supported path

1. Commit the task, integrate the latest `main`, run relevant tests, and merge into `main`. Resolve integration issues before building.
2. In the canonical main worktree, run:

   ```sh
   python3 packaging/prepare-panel-release.py --mode web
   # Or --mode control-plane for backend + web, --mode full for a full application build.
   ```

   This requires a completely clean main worktree (including untracked files), exports the exact full commit with `git archive` into a temporary build directory, pins the current live image, and writes a receipt only after a successful build and recheck. Ignored local secrets and generated files never enter the archive. The receipt binds the source SHA/tree, base image, build mode and resulting immutable image digest. Full builds preserve the pinned live image’s versioned downloads, reject conflicting immutable filenames, and replace only the two mutable manifests (`manifest.json` and `codex-manifest.json`). Application changes outside the chosen build mode are rejected; identity has a separate coordinated deployment procedure.

3. Publish the printed image tag/digest from the same canonical worktree:

   ```sh
   python3 packaging/deploy-control-plane.py --database /actual/volume/control-plane.sqlite \
     --image agentfleet:prepared-PRINTED-TAG --wait-seconds 60
   ```

   Under the existing database publication lock, the publisher validates the receipt, exact main HEAD, full source SHA in the image, live source ancestry, build mode and live base image. It repeats validation after calls/SSH streams drain and database backup finishes, immediately before retagging/recreation. Another successful deployment or main change makes an older build stale. Rebuild rather than relabel or retry the old build. Contending publishers fail the lock and can retry later; they cannot switch concurrently through this entrypoint.

The receipts live in `$(git rev-parse --git-common-dir)/agentfleet-releases/images/`, shared by every worktree. Receipt files are immutable once written. Keep this directory when backing up the repository. Missing or corrupted records block publication rather than guessing from a short build string. Existing voice/SSH fences, backups, readiness and public installer verification remain mandatory.

## Existing worktrees and the canonical entrypoint

Run `python3 packaging/install-release-entrypoints.py` from canonical main after merging this workflow. It installs small forwarding entrypoints in other registered worktrees (including old branches predating the publisher), and a local `AGENTS.md` deployment note where missing. Existing clean historical publisher/preparer files are backed up under the shared registry before replacement. Modified entrypoint files and existing non-managed notes are not overwritten; the installer reports them and fails for manual reconciliation. Application source, branches and other uncommitted work are not modified. New worktrees from current main already contain the rule and fail closed if publication is attempted outside main.

A forwarding file is a **local operational modification**, not a change to merge from an old task branch. Leave it in place, or update that worktree to current main. Removing/resetting it removes that compatibility protection.

## One-time legacy reconciliation

A live image previously built from uncommitted overlays has no truthful clean-build receipt. First identify every overlay, commit and integrate all its application source into main, and verify the resulting source against the running application/artifacts. Save reviewed JSON containing `source` (full main SHA), `image` (exact live Docker digest), `reconciliation` and `verification` evidence. Then run:

```sh
python3 packaging/adopt-live-release.py --expected-image sha256:EXACT_DIGEST --evidence /private/reconciliation.json
```

Adoption records an explicitly **reconciled legacy baseline**, not a claim that the old image was built from a clean commit. It is available only before any baseline or build receipt exists. It does not rebuild, retag, restart, change the database or grant a candidate permission to publish. The first normal release must still be built from clean main and pass every check. Do not delete the registry to re-enable adoption. Incomplete reconciliation means publication stays blocked.

## Recovery and boundary

There is intentionally no `--force`, automatic rollback, or arbitrary baseline reset. For a normal application rollback, revert the unwanted commits on main, test, and build a new descendant release. A failed switch can retain the existing admission fence; follow `voice-safe-deployment.md`. An unknown out-of-band live image must be investigated, not blessed by changing its version string.

These are enforced checks in the supported tooling, not protection from an administrator who can edit the receipt store or invoke Docker directly. Root/Docker-equivalent sessions can bypass scripts, reset old worktrees, or use old copied scripts. To make bypass technically impossible, run a dedicated deployment service under a separate identity, remove Docker/socket and receipt-store write access from development Agents, and admit releases through that service. Do not claim that AGENTS.md or local forwarding wrappers provide that permission boundary.
