import os
import sqlite3
import tempfile
from pathlib import Path

os.environ["API_TOKEN"] = "test-token-0123456789"
os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "test.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402

TOKEN = os.environ["API_TOKEN"]


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def auth(token: str = TOKEN) -> dict:
    return {"X-API-Token": token}


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_dashboard_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Nahovnost meter" in response.text


def test_fonts_are_served_with_correct_media_type(client):
    response = client.get("/static/fonts/inter-latin-wght-normal.woff2")
    assert response.status_code == 200
    assert response.headers["content-type"] == "font/woff2"


def test_ingest_requires_token(client):
    assert client.post("/api/readings", json={"value": 0.5}).status_code == 401
    assert (
        client.post(
            "/api/readings", json={"value": 0.5}, headers=auth("wrong-token")
        ).status_code
        == 401
    )


def test_ingest_accepts_header_and_bearer(client):
    created = client.post(
        "/api/readings", json={"value": 0.25}, headers=auth()
    )
    assert created.status_code == 201
    assert created.json()["value"] == 0.25

    bearer = client.post(
        "/api/readings",
        json={"value": 0.75},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert bearer.status_code == 201


@pytest.mark.parametrize("value", [-0.01, 1.01, 42, float("nan")])
def test_ingest_rejects_out_of_range(client, value):
    # NaN is sent as invalid JSON; the API must answer with a clean 422.
    response = client.post(
        "/api/readings",
        content=f'{{"value": {value}}}',
        headers={**auth(), "Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_ingest_accepts_boundaries(client):
    for value in (0.0, 1.0):
        response = client.post(
            "/api/readings", json={"value": value}, headers=auth()
        )
        assert response.status_code == 201


def test_ingest_stores_optional_comment(client):
    created = client.post(
        "/api/readings",
        json={"value": 0.33, "comment": "  ranní kontrola  "},
        headers=auth(),
    )
    assert created.status_code == 201
    assert created.json()["comment"] == "ranní kontrola"

    latest = client.get("/api/readings?hours=24").json()["latest"]
    assert latest["comment"] == "ranní kontrola"


def test_ingest_treats_blank_comment_as_missing(client):
    created = client.post(
        "/api/readings",
        json={"value": 0.4, "comment": "   "},
        headers=auth(),
    )
    assert created.status_code == 201
    assert created.json()["comment"] is None


def test_ingest_rejects_overlong_comment(client):
    response = client.post(
        "/api/readings",
        json={"value": 0.4, "comment": "x" * 501},
        headers=auth(),
    )
    assert response.status_code == 422


def test_all_readings_are_public_and_include_comments(client):
    client.post(
        "/api/readings",
        json={"value": 0.11, "comment": "start"},
        headers=auth(),
    )
    client.post(
        "/api/readings",
        json={"value": 0.88},
        headers=auth(),
    )

    response = client.get("/api/readings/all")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["count"] == len(body["readings"])
    assert body["count"] >= 2
    assert [item["created_at"] for item in body["readings"]] == sorted(
        item["created_at"] for item in body["readings"]
    )
    assert any(item["comment"] == "start" for item in body["readings"])
    assert all("comment" in item for item in body["readings"])


def test_init_db_migrates_legacy_table(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.execute(
        "CREATE TABLE readings ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "value REAL NOT NULL, "
        "created_at REAL NOT NULL)"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db, "DB_PATH", legacy)
    db.init_db()

    conn = sqlite3.connect(legacy)
    columns = [row[1] for row in conn.execute("PRAGMA table_info(readings)")]
    conn.close()
    assert "comment" in columns


def test_readings_returns_latest_and_points(client):
    client.post("/api/readings", json={"value": 0.1}, headers=auth())
    client.post("/api/readings", json={"value": 0.9}, headers=auth())

    payload = client.get("/api/readings?hours=24")
    assert payload.headers["cache-control"] == "no-store"
    body = payload.json()
    assert body["latest"]["value"] == 0.9
    assert len(body["points"]) >= 2
    assert body["stats"]["count"] >= 2
    assert body["stats"]["min"] <= body["stats"]["avg"] <= body["stats"]["max"]
    assert body["window_hours"] == 24


def test_readings_rejects_invalid_window(client):
    assert client.get("/api/readings?hours=0").status_code == 422
