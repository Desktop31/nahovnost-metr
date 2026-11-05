import json
import os
import sqlite3
import tempfile
from pathlib import Path

BASE = Path(tempfile.mkdtemp())
DB_FILE = BASE / "test.db"
CONFIG_FILE = BASE / "meters.json"

METERS = [
    {
        "slug": "alpha",
        "name": "Alpha",
        "description": "První měřidlo",
        "color": "#4f9d69",
        "token": "alpha-token-0123456789",
    },
    {
        "slug": "beta",
        "name": "Beta",
        "token": "beta-token-01234567890",
    },
]
CONFIG_FILE.write_text(json.dumps({"meters": METERS}), encoding="utf-8")

os.environ["DB_PATH"] = str(DB_FILE)
os.environ["METERS_CONFIG"] = str(CONFIG_FILE)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import config, db  # noqa: E402
from app.main import app  # noqa: E402

TOKENS = {meter["slug"]: meter["token"] for meter in METERS}


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def auth(slug: str = "alpha", token: str | None = None) -> dict:
    return {"X-API-Token": token or TOKENS[slug]}


def readings_url(slug: str, suffix: str = "") -> str:
    return f"/api/meters/{slug}/readings{suffix}"


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["meters"] == 2


def test_dashboard_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Nahovnost metr" in response.text
    assert "Všechna měřidla" in response.text


def test_meter_detail_page_is_served(client):
    response = client.get("/m/alpha")
    assert response.status_code == 200
    assert "Všechna měřidla" in response.text


def test_fonts_are_served_with_correct_media_type(client):
    response = client.get("/static/fonts/inter-latin-wght-normal.woff2")
    assert response.status_code == 200
    assert response.headers["content-type"] == "font/woff2"


def test_meters_are_public_but_tokens_are_not(client):
    response = client.get("/api/meters")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    meters = response.json()["meters"]
    assert [meter["slug"] for meter in meters] == ["alpha", "beta"]
    assert meters[0]["name"] == "Alpha"
    assert meters[0]["color"] == "#4f9d69"
    assert meters[1]["color"] is None
    assert all("token" not in meter for meter in meters)

    detail = client.get("/api/meters/alpha")
    assert detail.status_code == 200
    assert detail.json()["description"] == "První měřidlo"
    assert detail.json()["color"] == "#4f9d69"
    assert "token" not in detail.json()


def test_unknown_meter_returns_404(client):
    assert client.get("/api/meters/unknown").status_code == 404
    assert client.get(readings_url("unknown")).status_code == 404
    assert (
        client.post(
            readings_url("unknown"),
            json={"value": 0.5},
            headers={"X-API-Token": TOKENS["alpha"]},
        ).status_code
        == 404
    )


def test_ingest_requires_the_meter_token(client):
    assert client.post(readings_url("alpha"), json={"value": 0.5}).status_code == 401
    assert (
        client.post(
            readings_url("alpha"),
            json={"value": 0.5},
            headers=auth("alpha", "wrong-token-0123456789"),
        ).status_code
        == 401
    )
    # A token belonging to another meter must not work.
    assert (
        client.post(
            readings_url("alpha"),
            json={"value": 0.5},
            headers=auth("beta"),
        ).status_code
        == 401
    )


def test_ingest_accepts_header_and_bearer(client):
    created = client.post(
        readings_url("alpha"), json={"value": 0.25}, headers=auth("alpha")
    )
    assert created.status_code == 201
    assert created.json()["meter"] == "alpha"
    assert created.json()["value"] == 0.25

    bearer = client.post(
        readings_url("beta"),
        json={"value": 0.75},
        headers={"Authorization": f"Bearer {TOKENS['beta']}"},
    )
    assert bearer.status_code == 201
    assert bearer.json()["meter"] == "beta"


@pytest.mark.parametrize("value", [-0.01, 1.01, 42, float("nan")])
def test_ingest_rejects_out_of_range(client, value):
    response = client.post(
        readings_url("alpha"),
        content=f'{{"value": {value}}}',
        headers={**auth("alpha"), "Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_ingest_accepts_boundaries(client):
    for value in (0.0, 1.0):
        response = client.post(
            readings_url("alpha"), json={"value": value}, headers=auth("alpha")
        )
        assert response.status_code == 201


def test_ingest_stores_optional_comment(client):
    created = client.post(
        readings_url("alpha"),
        json={"value": 0.33, "comment": "  ranní kontrola  "},
        headers=auth("alpha"),
    )
    assert created.status_code == 201
    assert created.json()["comment"] == "ranní kontrola"

    latest = client.get(readings_url("alpha")).json()
    assert latest["meter"]["slug"] == "alpha"
    assert latest["latest"]["comment"] == "ranní kontrola"
    assert any(
        point.get("c") == "ranní kontrola" for point in latest["points"]
    )


def test_ingest_treats_blank_comment_as_missing(client):
    created = client.post(
        readings_url("alpha"),
        json={"value": 0.4, "comment": "   "},
        headers=auth("alpha"),
    )
    assert created.status_code == 201
    assert created.json()["comment"] is None


def test_ingest_rejects_overlong_comment(client):
    response = client.post(
        readings_url("alpha"),
        json={"value": 0.4, "comment": "x" * 501},
        headers=auth("alpha"),
    )
    assert response.status_code == 422


def test_readings_are_isolated_per_meter(client):
    client.post(
        readings_url("alpha"), json={"value": 0.11}, headers=auth("alpha")
    )
    client.post(
        readings_url("beta"), json={"value": 0.88}, headers=auth("beta")
    )

    alpha = client.get(readings_url("alpha")).json()
    beta = client.get(readings_url("beta")).json()
    assert alpha["latest"]["value"] == 0.11
    assert beta["latest"]["value"] == 0.88
    assert all(reading["meter"] == "alpha" for reading in client.get(
        readings_url("alpha", "/all")
    ).json()["readings"])
    assert all(reading["meter"] == "beta" for reading in client.get(
        readings_url("beta", "/all")
    ).json()["readings"])


def test_readings_points_and_stats(client):
    client.post(
        readings_url("alpha"), json={"value": 0.1}, headers=auth("alpha")
    )
    client.post(
        readings_url("alpha"), json={"value": 0.9}, headers=auth("alpha")
    )

    payload = client.get(readings_url("alpha", "?hours=24"))
    assert payload.headers["cache-control"] == "no-store"
    body = payload.json()
    assert body["latest"]["value"] == 0.9
    assert len(body["points"]) >= 2
    assert body["stats"]["count"] >= 2
    assert body["stats"]["min"] <= body["stats"]["avg"] <= body["stats"]["max"]
    assert body["window_hours"] == 24


def test_all_readings_are_public_and_include_comments(client):
    client.post(
        readings_url("alpha"),
        json={"value": 0.11, "comment": "start"},
        headers=auth("alpha"),
    )
    client.post(
        readings_url("alpha"), json={"value": 0.88}, headers=auth("alpha")
    )

    response = client.get(readings_url("alpha", "/all"))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["meter"]["slug"] == "alpha"
    assert body["count"] == len(body["readings"])
    assert body["count"] >= 2
    assert [item["created_at"] for item in body["readings"]] == sorted(
        item["created_at"] for item in body["readings"]
    )
    assert any(item["comment"] == "start" for item in body["readings"])
    assert all(item["meter"] == "alpha" for item in body["readings"])
    assert all("comment" in item for item in body["readings"])


def test_readings_reject_invalid_window(client):
    assert client.get(readings_url("alpha", "?hours=0")).status_code == 422


def test_init_db_migrates_legacy_table(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.execute(
        "CREATE TABLE readings ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "value REAL NOT NULL, "
        "created_at REAL NOT NULL)"
    )
    conn.execute(
        "INSERT INTO readings (value, created_at) VALUES (?, ?)",
        (0.42, 1793290136.4),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db, "DB_PATH", legacy)
    db.init_db()

    conn = sqlite3.connect(legacy)
    columns = [row[1] for row in conn.execute("PRAGMA table_info(readings)")]
    row = conn.execute(
        "SELECT meter, comment FROM readings ORDER BY id LIMIT 1"
    ).fetchone()
    conn.close()
    assert "meter" in columns
    assert "comment" in columns
    assert row == ("default", None)


def test_config_rejects_invalid_color(tmp_path, monkeypatch):
    path = tmp_path / "meters.json"
    path.write_text(
        json.dumps(
            {
                "meters": [
                    {
                        "slug": "one",
                        "name": "One",
                        "color": "blue",
                        "token": "valid-token-0123456789",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    config.reset_cache()
    with pytest.raises(config.ConfigError):
        config.load_meters()
    config.reset_cache()


def test_config_rejects_duplicate_tokens(tmp_path, monkeypatch):
    path = tmp_path / "meters.json"
    path.write_text(
        json.dumps(
            {
                "meters": [
                    {"slug": "one", "name": "One", "token": "same-token-0123456789"},
                    {"slug": "two", "name": "Two", "token": "same-token-0123456789"},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    config.reset_cache()
    with pytest.raises(config.ConfigError):
        config.load_meters()
    config.reset_cache()


def test_ensure_config_bootstraps_one_meter(tmp_path, monkeypatch):
    path = tmp_path / "meters.json"
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    config.reset_cache()
    config.ensure_config()

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert [meter["slug"] for meter in payload["meters"]] == ["default"]
    assert len(payload["meters"][0]["token"]) == 64
    assert path.stat().st_mode & 0o777 == 0o600
    assert config.load_meters()[0].slug == "default"
    config.reset_cache()
