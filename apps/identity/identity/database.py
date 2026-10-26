import os
from urllib.parse import parse_qsl, unquote, urlsplit


def database_config(base_dir):
    url = os.getenv("DJANGO_DATABASE_URL", "")
    if not url:
        return {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": os.getenv("DJANGO_DATABASE_PATH", str(base_dir / "identity.sqlite")),
            "OPTIONS": {"timeout": 20, "transaction_mode": "IMMEDIATE"},
        }
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.path.strip("/"):
        raise ValueError("DJANGO_DATABASE_URL must name a PostgreSQL database")
    options = dict(parse_qsl(parsed.query, strict_parsing=True))
    if set(options) - {"sslmode", "sslrootcert", "connect_timeout", "application_name"}:
        raise ValueError("Unsupported PostgreSQL connection option")
    return {
        "ENGINE": "django.db.backends.postgresql", "NAME": unquote(parsed.path[1:]),
        "USER": unquote(parsed.username or ""), "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname, "PORT": parsed.port or 5432,
        "CONN_MAX_AGE": 60, "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {"connect_timeout": 10, **options},
    }
