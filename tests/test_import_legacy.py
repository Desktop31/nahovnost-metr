import sqlite3

import pytest

from app import db
from app.import_legacy import import_legacy


def make_legacy(path, rows, *, comment=False, meter=None):
    conn = sqlite3.connect(path)
    columns = "id INTEGER PRIMARY KEY AUTOINCREMENT, value REAL NOT NULL, created_at REAL NOT NULL"
    if comment:
        columns += ", comment TEXT"
    if meter:
        columns += ", meter TEXT"
    conn.execute(f"CREATE TABLE readings ({columns})")
    for value, created_at, note in rows:
        if comment and meter:
            conn.execute(
                "INSERT INTO readings (value, created_at, comment, meter) "
                "VALUES (?, ?, ?, ?)",
                (value, created_at, note, meter),
            )
        elif comment:
            conn.execute(
                "INSERT INTO readings (value, created_at, comment) VALUES (?, ?, ?)",
                (value, created_at, note),
            )
        elif meter:
            conn.execute(
                "INSERT INTO readings (value, created_at, meter) VALUES (?, ?, ?)",
                (value, created_at, meter),
            )
        else:
            conn.execute(
                "INSERT INTO readings (value, created_at) VALUES (?, ?)",
                (value, created_at),
            )
    conn.commit()
    conn.close()


def test_import_legacy_and_skip_duplicates(tmp_path):
    source = tmp_path / "legacy.db"
    target = tmp_path / "new.db"
    make_legacy(
        source,
        [(0.1, 1793290000.1, None), (0.4, 1793290100.2, None)],
    )

    before_path = db.DB_PATH
    result = import_legacy(source, target, "home")
    assert db.DB_PATH == before_path
    assert result["source_rows"] == 2
    assert result["imported"] == 2
    assert result["skipped"] == 0
    assert result["meter_rows_after"] == 2

    again = import_legacy(source, target, "home")
    assert again["imported"] == 0
    assert again["skipped"] == 2
    assert again["meter_rows_after"] == 2

    conn = sqlite3.connect(target)
    rows = conn.execute(
        "SELECT meter, value, created_at, comment FROM readings ORDER BY created_at"
    ).fetchall()
    conn.close()
    assert rows == [
        ("home", 0.1, 1793290000.1, None),
        ("home", 0.4, 1793290100.2, None),
    ]


def test_import_legacy_preserves_comments_and_filters_source_meter(tmp_path):
    source = tmp_path / "legacy.db"
    target = tmp_path / "new.db"
    make_legacy(
        source,
        [(0.2, 1793290000.1, "první"), (0.8, 1793290100.2, "druhá")],
        comment=True,
        meter="home",
    )

    with pytest.raises(ValueError, match="source-meter"):
        import_legacy(source, target, "imported")

    result = import_legacy(source, target, "imported", source_meter="home")
    assert result["imported"] == 2

    conn = sqlite3.connect(target)
    rows = conn.execute(
        "SELECT meter, value, comment FROM readings ORDER BY created_at"
    ).fetchall()
    conn.close()
    assert rows == [
        ("imported", 0.2, "první"),
        ("imported", 0.8, "druhá"),
    ]


def test_import_legacy_rejects_invalid_slug(tmp_path):
    source = tmp_path / "legacy.db"
    make_legacy(source, [(0.1, 1793290000.1, None)])
    with pytest.raises(ValueError, match="slug"):
        import_legacy(source, tmp_path / "new.db", "Bad Slug")
