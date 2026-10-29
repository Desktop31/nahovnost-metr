import os
import tempfile
from pathlib import Path

os.environ["API_TOKEN"] = "test-token-0123456789"
os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "test.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

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


def test_readings_returns_latest_and_points(client):
    client.post("/api/readings", json={"value": 0.1}, headers=auth())
    client.post("/api/readings", json={"value": 0.9}, headers=auth())

    payload = client.get("/api/readings?hours=24").json()
    assert payload["latest"]["value"] == 0.9
    assert len(payload["points"]) >= 2
    assert payload["stats"]["count"] >= 2
    assert payload["stats"]["min"] <= payload["stats"]["avg"] <= payload["stats"]["max"]
    assert payload["window_hours"] == 24


def test_readings_rejects_invalid_window(client):
    assert client.get("/api/readings?hours=0").status_code == 422
