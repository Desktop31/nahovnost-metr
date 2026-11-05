"""Import a legacy single-meter SQLite database into the multi-meter database.

Legacy databases have a ``readings`` table without the ``meter`` column. This
script copies their rows into a newer database and assigns them to one meter
slug. It preserves values, timestamps and comments. Re-running it skips rows
that are already present (same meter, timestamp, value and comment).

Run it while the new app is stopped, or accept SQLite's WAL locking:

    python -m app.import_legacy --source old1.db --meter home

In Docker, mount the old DB and let the service volume provide /data:

    docker compose stop meter
    docker compose run --rm \\
      -v "$PWD/old1.db:/tmp/old1.db:ro" \\
      meter python -m app.import_legacy \\
      --source /tmp/old1.db --target /data/readings.db --meter home

The meters.json entry and its token are not created automatically.
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

from . import db

SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"


def _columns(connection: sqlite3.Connection) -> set[str]:
    return {
        row[1]
        for row in connection.execute("PRAGMA table_info(readings)").fetchall()
    }


def import_legacy(
    source: Path,
    target: Path,
    meter: str,
    source_meter: str | None = None,
) -> dict:
    """Copy readings from one legacy DB into ``target`` under ``meter``."""
    source = source.expanduser()
    target = target.expanduser()

    if not re.fullmatch(SLUG_PATTERN, meter):
        raise ValueError(
            "Meter slug must be lowercase letters, digits and hyphens, "
            "and must start/end with a letter or digit."
        )
    if not source.exists():
        raise ValueError(f"Source database does not exist: {source}")
    if source.resolve() == target.resolve():
        raise ValueError("Source and target databases must be different files.")

    source_uri = source.resolve().as_uri() + "?mode=ro"
    try:
        src = sqlite3.connect(source_uri, uri=True)
    except sqlite3.Error as error:
        raise ValueError(f"Cannot open source database {source}: {error}") from error
    src.row_factory = sqlite3.Row

    try:
        table = src.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name = 'readings'"
        ).fetchone()
        if table is None:
            raise ValueError(f"Source database {source} has no readings table.")

        columns = _columns(src)
        missing = {"value", "created_at"} - columns
        if missing:
            raise ValueError(
                f"Source readings table is missing columns: {', '.join(sorted(missing))}"
            )

        has_comment = "comment" in columns
        has_meter = "meter" in columns
        if has_meter and not source_meter:
            raise ValueError(
                "Source already has a meter column. Pass --source-meter to select "
                "which source meter to import."
            )

        selected = "value, created_at"
        selected += ", comment" if has_comment else ", NULL AS comment"
        sql = f"SELECT {selected} FROM readings"
        parameters: tuple = ()
        if has_meter:
            sql += " WHERE meter = ?"
            parameters = (source_meter,)
        sql += " ORDER BY created_at"

        rows = src.execute(sql, parameters)

        target_existed = target.exists()
        old_db_path = db.DB_PATH
        db.DB_PATH = target
        try:
            db.init_db()
            with db.connect() as dst:
                dst.execute("BEGIN IMMEDIATE")
                before = dst.execute(
                    "SELECT COUNT(*) FROM readings WHERE meter = ?", (meter,)
                ).fetchone()[0]

                inserted = 0
                skipped = 0
                total = 0
                oldest = None
                for row in rows:
                    total += 1
                    created_at = row["created_at"]
                    if oldest is None or created_at < oldest:
                        oldest = created_at
                    cursor = dst.execute(
                        """
                        INSERT INTO readings (meter, value, created_at, comment)
                        SELECT ?, ?, ?, ?
                        WHERE NOT EXISTS (
                            SELECT 1 FROM readings
                            WHERE meter = ?
                              AND created_at = ?
                              AND value = ?
                              AND comment IS ?
                        )
                        """,
                        (
                            meter,
                            row["value"],
                            created_at,
                            row["comment"],
                            meter,
                            created_at,
                            row["value"],
                            row["comment"],
                        ),
                    )
                    if cursor.rowcount:
                        inserted += 1
                    else:
                        skipped += 1

                after = dst.execute(
                    "SELECT COUNT(*) FROM readings WHERE meter = ?", (meter,)
                ).fetchone()[0]
        finally:
            db.DB_PATH = old_db_path
    finally:
        src.close()

    result = {
        "source": str(source),
        "target": str(target),
        "meter": meter,
        "source_rows": total,
        "imported": inserted,
        "skipped": skipped,
        "meter_rows_before": before,
        "meter_rows_after": after,
        "oldest": oldest,
        "target_created": not target_existed,
    }

    if oldest is not None:
        retention_days = int(os.environ.get("RETENTION_DAYS", "30"))
        cutoff = time.time() - retention_days * 86400
        if oldest < cutoff:
            result["retention_warning"] = (
                f"Oldest imported row is older than RETENTION_DAYS="
                f"{retention_days}; the app will prune it on the next write. "
                "Raise RETENTION_DAYS before importing if you need that history."
            )

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument(
        "--target",
        type=Path,
        default=Path(os.environ.get("DB_PATH", "data/readings.db")),
    )
    parser.add_argument("--meter", required=True, help="Target meter slug")
    parser.add_argument(
        "--source-meter",
        help="If the source is already multi-meter, select this source slug",
    )
    args = parser.parse_args()

    try:
        result = import_legacy(
            source=args.source,
            target=args.target,
            meter=args.meter,
            source_meter=args.source_meter,
        )
    except (ValueError, sqlite3.Error) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1

    print(
        "Imported {imported} rows into '{meter}' "
        "({skipped} duplicates skipped; {meter_rows_after} rows now).".format(
            **result
        )
    )
    if result.get("target_created"):
        print(f"Created target database: {result['target']}")
    if result.get("retention_warning"):
        print(f"Warning: {result['retention_warning']}", file=sys.stderr)
    print(
        "Add the meter and a token to meters.json before exposing it via the API.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
