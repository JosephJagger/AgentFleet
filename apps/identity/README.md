# Django identity service

AgentFleets uses email + a six-digit Resend code, following the memo project's two-step login flow. The first successful verification creates a Django user with an unusable password. Every email owns a separate control-plane workspace. The existing `ADMIN_EMAIL` links to its existing workspace on first verification.

Django owns users, challenges and durable abuse limits in its own SQLite or PostgreSQL database. The control plane authenticates to Django with `DJANGO_AUTH_SERVICE_TOKEN`, accepts only a verified identity, and issues its existing revocable HttpOnly session and CSRF token. Browser requests never access the internal identity endpoints directly. Django's service has no published Docker port. No Django session cookies are used.

## Configuration

Set these **only in the root `.env`**, which is excluded from Git and Docker build contexts:

```dotenv
AUTH_MODE=email
ADMIN_EMAIL=owner@example.com
DJANGO_AUTH_URL=http://identity:8000
DJANGO_AUTH_SERVICE_TOKEN=generate-an-independent-secret-of-at-least-32-characters
DJANGO_SECRET_KEY=generate-another-independent-secret-of-at-least-32-characters
RESEND_API_KEY=your-resend-key
RESEND_FROM_EMAIL=login@your-verified-domain.example
RESEND_FROM_NAME=AgentFleets
```

Generate each Django secret separately with `openssl rand -hex 48`. Resend's [Send Email API](https://resend.com/docs/api-reference/emails/send-email) requires a sender configured for your account. The example file contains no real credentials. Do not use `VITE_` variables for secrets.

Follow the [release procedure](../../docs/release-provenance.md) for deployment. Migrations run before gunicorn starts. Back up both databases, the `agentfleet-data` and `agentfleet-identity` volumes, and `.env`. Preserve `ADMIN_EMAIL` during upgrades. Migration 36 adds an optional unique identity link without changing existing workspace IDs, resources or sessions. Existing sessions retain their original expiry/revocation behavior.

Codes expire after 10 minutes, allow at most 5 failed attempts, and can be used once. A successful resend invalidates older codes. Sends are limited to one per email per minute, 5 per email per hour, 20 per IP per hour, 200 globally per hour and 1,000 globally per day. Verification is limited to 60 per IP per hour. SQLite IMMEDIATE transactions serialize these limits and consumption across workers. Only keyed digests are stored, and provider errors do not expose credentials or codes. Expired challenge/rate records are pruned after 24 hours during subsequent requests.

The configured platform administrator alone can operate the shared runtime release channel. All users own their own workspaces; shared team membership and invitations are not implemented. Django `is_active=False` prevents future sign-ins; already issued control-plane sessions must also be revoked to end existing access.

`AUTH_MODE=password` is an explicitly enabled backend compatibility mode for existing installations/tests. The new browser UI and Compose deployment always use email verification; there is no automatic password fallback when mail or Django is unavailable.

## Local development and tests

```sh
python3 -m venv .venv
.venv/bin/pip install -r apps/identity/requirements.txt
# Export Django secrets and Resend configuration in your shell first.
.venv/bin/python apps/identity/manage.py migrate
.venv/bin/python apps/identity/manage.py runserver 127.0.0.1:8000
# The local Node process needs DJANGO_AUTH_URL=http://127.0.0.1:8000.
```

Tests use a fake mail sender and never send real email:

```sh
DJANGO_SECRET_KEY=test-secret-at-least-thirty-two-characters \
DJANGO_AUTH_SERVICE_TOKEN=test-service-token-at-least-thirty-two-characters \
.venv/bin/python apps/identity/manage.py test accounts
```

The identity database is independent of the Node schema. Do not point `DJANGO_DATABASE_PATH` at `control-plane.sqlite`.

## PostgreSQL

Set `DJANGO_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/IDENTITY_DATABASE` to use PostgreSQL. URL-encode credentials and keep them in private environment configuration. Without that variable the existing SQLite configuration remains active. Use a separate database from the control plane. `psycopg` is installed by `requirements.txt`; SQLite's IMMEDIATE transaction option is never passed to PostgreSQL.

Authentication transactions take a PostgreSQL transaction advisory lock before rate accounting or OTP consumption, preserving serialization across gunicorn workers, including a rate bucket's first request. OTP reads also use `SELECT FOR UPDATE`. Email delivery happens outside the lock. Tests include two independent connections racing on an OTP and a resend cooldown.

For rehearsal, point the URL at a fresh database, run `manage.py migrate --noinput`, then:

```sh
python manage.py import_sqlite --snapshot /private/identity-copy.sqlite --report /private/identity-preflight.json
python manage.py import_sqlite --snapshot /private/identity-copy.sqlite --report /private/identity-import.json --apply
python manage.py test accounts --keepdb --noinput
```

The source must be a SQLite backup with matching Django migrations. The importer opens it read-only, refuses nonempty destination application tables, preserves user UUIDs and password hashes, maps permission/content-type references with natural keys, verifies serialized model content, resets sequences, and commits atomically. Migration metadata and generated permission/content-type rows are established by Django's migrations. For tests with a role that cannot create databases, provision the empty `test_<IDENTITY_DATABASE>` owned by that role in advance; keep it separate from rehearsal data. The mail sender is mocked in all login tests.

Retain `DJANGO_SECRET_KEY` and the service token at actual cutover. Arrange a coordinated window for this service and the control plane; the panel publisher alone does not deploy identity or stop its writers.
