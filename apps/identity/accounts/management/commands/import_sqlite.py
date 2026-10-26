"""Import a read-only SQLite identity snapshot into a migrated, empty PostgreSQL DB."""
import copy
import hashlib
import json
import os
import sqlite3
from pathlib import Path

from django.apps import apps
from django.core import serializers
from django.core.management.base import BaseCommand, CommandError
from django.core.management.color import no_style
from django.db import connections, transaction


MODELS = ("auth.Group", "accounts.User", "accounts.EmailChallenge", "accounts.RateEvent")


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, parser):
        parser.add_argument("--snapshot", required=True)
        parser.add_argument("--report", required=True)
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        source = Path(options["snapshot"]).resolve(strict=True)
        target = connections["default"]
        if target.vendor != "postgresql":
            raise CommandError("Destination must be PostgreSQL")
        if Path(options["report"]).exists():
            raise CommandError("Report already exists; refusing to overwrite it")
        source_hash = digest(source)
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA quick_check").fetchall() != [("ok",)] or db.execute("PRAGMA foreign_key_check").fetchall():
                raise CommandError("SQLite snapshot failed integrity validation")
            source_migrations = set(db.execute("SELECT app,name FROM django_migrations"))
        with target.cursor() as cursor:
            cursor.execute("SELECT app,name FROM django_migrations")
            if source_migrations != set(cursor.fetchall()):
                raise CommandError("Source and destination Django migrations differ; upgrade a separate source copy first")
        config = copy.deepcopy(target.settings_dict)
        config.update(ENGINE="django.db.backends.sqlite3", NAME=source.as_uri() + "?mode=ro", OPTIONS={"uri": True}, CONN_MAX_AGE=0)
        connections.databases["migration_source"] = config
        models = [apps.get_model(label) for label in MODELS]
        proofs = []
        try:
            with transaction.atomic():
                with target.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':agentfleet-identity', 0))")
                    # Exclude live ORM writers for the entire import/verification window.
                    names = [target.ops.quote_name(m._meta.db_table) for m in models]
                    cursor.execute("LOCK TABLE " + ",".join(names) + " IN ACCESS EXCLUSIVE MODE")
                if any(model.objects.exists() for model in models):
                    raise CommandError("Destination identity tables must be empty")
                for model in models:
                    payload = serializers.serialize("json", model.objects.using("migration_source").order_by("pk"), use_natural_foreign_keys=True)
                    records = json.loads(payload)
                    checksum = hashlib.sha256(payload.encode()).hexdigest()
                    if options["apply"]:
                        for record in serializers.deserialize("json", payload, using="default"):
                            record.save(using="default")
                        actual = serializers.serialize("json", model.objects.order_by("pk"), use_natural_foreign_keys=True)
                        if payload != actual:
                            raise CommandError(f"Content verification failed: {model._meta.label}")
                    proofs.append({"model": model._meta.label, "rows": len(records), "sha256": checksum})
                if digest(source) != source_hash:
                    raise CommandError("Snapshot changed during import")
                if options["apply"]:
                    with target.cursor() as cursor:
                        for sql in target.ops.sequence_reset_sql(no_style(), models):
                            cursor.execute(sql)
                        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        finally:
            connections["migration_source"].close()
        report = {"applied": options["apply"], "sourceSha256": source_hash, "models": proofs}
        fd = os.open(options["report"], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(report, stream, indent=2)
        self.stdout.write(json.dumps({"applied": options["apply"], "rows": sum(p["rows"] for p in proofs), "verifiedModels": len(proofs)}))
