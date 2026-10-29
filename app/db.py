"""SQLite persistence for meter readings."""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.environ.get("DB_PATH", "data/readings.db"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "30"))
MAX_POINTS = 1500


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS readings (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                value      REAL NOT NULL CHECK (value >= 0.0 AND value <= 1.0),
                created_at REAL NOT NULL,
                comment    TEXT
            )
            """
        )
        # Existing databases predate the optional comment column.
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(readings)").fetchall()
        }
        if "comment" not in columns:
            conn.execute("ALTER TABLE readings ADD COLUMN comment TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_readings_created_at "
            "ON readings (created_at)"
        )


def add_reading(value: float, comment: str | None = None) -> dict:
    now = time.time()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO readings (value, created_at, comment) VALUES (?, ?, ?)",
            (value, now, comment),
        )
        reading_id = cur.lastrowid
        # Bounded storage: drop everything past the retention window.
        conn.execute(
            "DELETE FROM readings WHERE created_at < ?",
            (now - RETENTION_DAYS * 86400,),
        )
    return {
        "id": reading_id,
        "value": value,
        "created_at": now,
        "comment": comment,
    }


def _row_to_reading(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "value": row["value"],
        "created_at": row["created_at"],
        "comment": row["comment"],
    }


def latest_reading() -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT id, value, created_at, comment FROM readings "
            "ORDER BY created_at DESC, id DESC LIMIT 1"
        ).fetchone()
    return _row_to_reading(row) if row else None


def all_readings() -> list[dict]:
    """Every stored reading, oldest first, including comments."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, value, created_at, comment FROM readings "
            "ORDER BY created_at ASC, id ASC"
        ).fetchall()
    return [_row_to_reading(row) for row in rows]


def readings_window(hours: float) -> tuple[list[dict], dict]:
    """Return readings from the last `hours`, downsampled when dense."""
    now = time.time()
    since = now - hours * 3600
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, value, created_at FROM readings "
            "WHERE created_at >= ? ORDER BY created_at ASC, id ASC",
            (since,),
        ).fetchall()
        agg = conn.execute(
            "SELECT COUNT(*) AS count, MIN(value) AS min, MAX(value) AS max, "
            "AVG(value) AS avg FROM readings WHERE created_at >= ?",
            (since,),
        ).fetchone()

    points: list[dict]
    if len(rows) > MAX_POINTS:
        bucket = hours * 3600 / MAX_POINTS
        buckets: dict[int, list[float]] = {}
        for row in rows:
            key = int((row["created_at"] - since) / bucket)
            buckets.setdefault(key, []).append(row["value"])
        points = [
            {
                "t": since + (key + 0.5) * bucket,
                "v": round(sum(values) / len(values), 6),
            }
            for key, values in sorted(buckets.items())
        ]
    else:
        points = [
            {"t": row["created_at"], "v": row["value"]} for row in rows
        ]

    stats = {
        "count": agg["count"] or 0,
        "min": agg["min"],
        "max": agg["max"],
        "avg": agg["avg"],
    }
    return points, stats
