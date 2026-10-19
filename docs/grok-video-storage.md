# Grok video output on B52H

Grok Build supports user-managed S3 output with ZDR enabled. Native settings live under
`tools.zdr_video_output_s3`, with `bucket`, `endpoint`, `region`, `key_prefix`,
`expires_secs`, and `read_write` / `read_only` credentials.

**Put this table in `$GROK_HOME/config.toml` (mode 0600), not in `managed_config.toml`.**
xAI's page names `managed_config.toml`, but on a signed-in host Grok maintains that file
itself from the account's synced managed settings (`settings_cache.json`, `grok setup`),
and it was observed removed within the hour, after which video tools were again refused
as ZDR. The config reference lists the key as user-settable, and `config.toml` is not
rewritten by the sync. `grok inspect` does not show this table, so the only real check is
the next native video task. A new Grok process is required to pick the change up. Never commit credentials. Existing Grok processes must naturally end
and reopen to pick up configuration; do not kill active tasks or the shared leader.
This does not enable data-sharing/training opt-in.

## Deployment

B52H uses Garage v2.4.1, pinned image digest
`sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`.
The isolated `agentfleet-video-storage` container listens on host loopback port 3900;
RPC and admin ports are not published. Memory is capped at 512 MiB, CPU at one core.
Persistent metadata and objects are in `/var/lib/agentfleet-video/data`; configuration
and recovery credentials are in the parent directory (root-only). Keep both metadata
and data when backing up. Single-node storage has no redundant copy.

The private bucket `agentfleet-grok-videos` has a 5,000,000,000-byte and 10,000-object
quota. No automatic deletion of completed videos is configured. Quotas concern live
objects, not immediate physical disk usage: Garage reclaims deleted blocks later.
Monitor host disk separately; do not treat this bucket limit as a filesystem quota.

The existing HTTPS virtual host forwards only `/agentfleet-grok-videos` to Garage,
without rewriting Host or URI (AWS Signature V4). Cookies are stripped, access logs
are disabled to avoid persisting bearer URLs, and downloads are forced to attachment
with `nosniff`. Anonymous reads are forbidden by S3 authentication. The Nginx body
limit is 256 MiB per request. The proxy uses graceful reload, not a restart.

## Panel settings

`Settings → Video storage` lists 20 objects per request, supports previous/next pages,
5-minute signed downloads, and explicit single-file permanent deletion. It does not
scan projects, delete source images, clear sessions, or affect cloud history policy.
Credentials never enter browser responses. A root-managed `video-storage.json` beside
the control-plane database binds exactly one workspace and prefix to this bucket:

```json
{
  "workspaceId": "<authorized workspace>", "label": "B52H",
  "endpoint": "https://panel.example.com", "region": "garage",
  "bucket": "agentfleet-grok-videos", "prefix": "grok-videos/",
  "quotaBytes": 5000000000,
  "accessKeyId": "<dedicated panel key>", "secretAccessKey": "<secret>"
}
```

Set file mode 0600 and owner to the control-plane container UID. No config means an
unconfigured UI, not an empty successful listing. Other workspaces cannot access it.
All routes use existing authentication; downloads and deletions also require CSRF.
Delete requests recheck ETag, size and modification time, reject files younger than
one minute, and record requested/completed audit entries. Errors are sanitized.

**Concurrency limit:** Garage v2.4.1 experimentally ignores DeleteObject If-Match.
The adapter sends it for compatible backends, but on Garage the HEAD recheck is best
effort, not an atomic compare-and-delete. Grok output should use unique object keys;
do not overwrite an existing key while deleting it. A recently created presigned
upload URL can write a file again until its expiry. Download before permanent removal.

## Verification and release

Verify anonymous denial, presigned PUT/GET, read-only write denial, listing pagination,
workspace isolation, stale-file rejection, CSRF, audit, and confirmation UI. Probe
objects must have unique names and be deleted after the check. A successful S3 probe
is not proof of an end-to-end paid video generation; verify the next native Grok task.
Use `packaging/deploy-control-plane.py` for panel publication, respecting active voice
calls. No Agent version bump is required for these panel-only changes.

Sources: https://docs.x.ai/build/settings/zdr-video-storage and
https://garagehq.deuxfleurs.fr/documentation/quick-start/ .
